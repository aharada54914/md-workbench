//! Disposable fixtures only. Never adopt, repair or traverse caller-owned entries.
use crate::{
    report::{Operation as Op, Outcome, Reason, Report},
    windows::observe,
    windows_acl as acl,
};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions, OpenOptionsExt};
use std::{
    ffi::OsString,
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
    Storage::FileSystem::*,
    System::{
        Ioctl::FSCTL_SET_REPARSE_POINT,
        SystemServices::{FILE_PERSISTENT_ACLS, IO_REPARSE_TAG_MOUNT_POINT},
        IO::DeviceIoControl,
    },
};

const PRIVATE: &str = "acl-private";
const SENTINEL: &[u8] = b"disposable-acl-probe-control";
const OPEN_FLAGS: u32 = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;

pub fn run(root: &Dir, report: &mut Report) {
    if report
        .filesystem
        .as_ref()
        .is_none_or(|f| f.flags & FILE_PERSISTENT_ACLS == 0)
    {
        report.set(
            Op::QueryProcessIdentity,
            Outcome::Skipped {
                reason: Reason::MissingPersistentAcls,
            },
        );
        return;
    }
    let Some(identity) = observe(report, Op::QueryProcessIdentity, acl::identity()) else {
        return;
    };
    report.token_elevated = Some(identity.elevated);
    // Explicit no-delete-sharing pin, independent of the RW-directory flush probe.
    let root_pin = pin(root);
    let Some(root_pin) = observe(report, Op::CreatePrivateDirectory, root_pin) else {
        return;
    };
    let mut created: Vec<(&str, bool)> = Vec::new();
    exercise(&root_pin, &identity.sid, report, &mut created);
    let cleanup = cleanup(&root_pin, &created);
    observe(report, Op::CleanupAcl, cleanup);
}

fn exercise(root: &Dir, user: &str, report: &mut Report, created: &mut Vec<(&'static str, bool)>) {
    let prepare = (|| {
        let base = handle_path(root)?;
        let sd = acl::descriptor(&acl::private_sddl(user, true))?;
        create_directory(&base.join(PRIVATE), &sd)?;
        created.push((PRIVATE, true));
        let private = open(&base.join(PRIVATE), false, None)?;
        check_kind(&private, true)?;
        Ok((private, base.join(PRIVATE)))
    })();
    let Some((private, path)) = observe(report, Op::CreatePrivateDirectory, prepare) else {
        return;
    };
    if observe(
        report,
        Op::InspectPrivateDirectory,
        acl::inspect(&private, user, true),
    )
    .is_none()
    {
        return;
    }
    let file_sd = match acl::descriptor(&acl::private_sddl(user, false)) {
        Ok(value) => value,
        Err(error) => {
            observe::<()>(report, Op::CreatePrivateFile, Err(error));
            return;
        }
    };
    let safe_file = open(&path.join("private.bin"), true, Some(&file_sd));
    if safe_file.is_ok() {
        created.push(("acl-private/private.bin", false));
    }
    let Some(safe_file) = observe(report, Op::CreatePrivateFile, safe_file) else {
        return;
    };
    observe(
        report,
        Op::InspectPrivateFile,
        check_kind(&safe_file, false).and_then(|()| acl::inspect(&safe_file, user, false)),
    );
    drop(safe_file);

    // Unsafe leaves contain no data and sit under the already verified private parent.
    for (name, relative, sddl, create_op, reject_op, reason) in [
        (
            "broad.bin",
            "acl-private/broad.bin",
            format!("O:{user}D:P(A;;FA;;;{user})(A;;FA;;;SY)(A;;FA;;;WD)"),
            Op::CreateBroadAclFile,
            Op::RejectBroadAclFile,
            Reason::UnexpectedAcl,
        ),
        (
            "null.bin",
            "acl-private/null.bin",
            format!("O:{user}D:NO_ACCESS_CONTROL"),
            Op::CreateNullAclFile,
            Op::RejectNullAclFile,
            Reason::NullOrMissingDacl,
        ),
        (
            "unprotected.bin",
            "acl-private/unprotected.bin",
            format!("O:{user}D:(A;;FA;;;{user})(A;;FA;;;SY)"),
            Op::CreateUnprotectedAclFile,
            Op::RejectUnprotectedAclFile,
            Reason::UnprotectedDacl,
        ),
    ] {
        let sd = if reason == Reason::NullOrMissingDacl {
            acl::protected_null_descriptor(user)
        } else {
            acl::descriptor(&sddl)
        };
        let file = sd.and_then(|sd| open(&path.join(name), true, Some(&sd)));
        if file.is_ok() {
            created.push((relative, false));
        }
        if let Some(file) = observe(report, create_op, file) {
            rejection(
                report,
                reject_op,
                reason,
                check_kind(&file, false).and_then(|()| acl::inspect(&file, user, false)),
            );
        }
    }
    junction(&path, user, report, created);
    // private remains open without delete sharing until all child operations finish.
}

fn junction(path: &Path, user: &str, report: &mut Report, created: &mut Vec<(&'static str, bool)>) {
    let fixtures = (|| {
        let sd = acl::descriptor(&acl::private_sddl(user, true))?;
        create_directory(&path.join("target"), &sd)?;
        created.push(("acl-private/target", true));
        let target = open(&path.join("target"), false, None)?;
        check_kind(&target, true)?;
        let file_sd = acl::descriptor(&acl::private_sddl(user, false))?;
        let mut sentinel = open(&path.join("target/sentinel.bin"), true, Some(&file_sd))?;
        created.push(("acl-private/target/sentinel.bin", false));
        sentinel.write_all(SENTINEL)?;
        create_directory(&path.join("junction"), &sd)?;
        created.push(("acl-private/junction", true));
        let link = open(&path.join("junction"), true, None)?;
        set_junction(&link, &handle_path(&target)?)?;
        Ok((sentinel, target, link))
    })();
    let Some((mut sentinel, _target, link)) = observe(report, Op::CreateJunction, fixtures) else {
        return;
    };
    // Reopen the junction itself with OPEN_REPARSE_POINT, then inspect the retained
    // handle. No child path beneath the junction is ever used for a write.
    let result = open(&path.join("junction"), false, None).and_then(|handle| {
        check_kind(&handle, true).and_then(|()| acl::inspect(&handle, user, true))
    });
    rejection(
        report,
        Op::RejectJunction,
        Reason::UnexpectedFileType,
        result,
    );
    let verify = (|| {
        sentinel.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        (&mut sentinel)
            .take(SENTINEL.len() as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes != SENTINEL {
            return Err(acl::error(Reason::SentinelChanged));
        }
        Ok(())
    })();
    observe(report, Op::VerifyAclSentinel, verify);
    drop(link);
}

fn rejection(report: &mut Report, op: Op, expected: Reason, result: io::Result<()>) {
    match result {
        Err(error)
            if error.get_ref().and_then(|e| e.downcast_ref::<Reason>()) == Some(&expected) =>
        {
            report.set(op, Outcome::Rejected { reason: expected });
        }
        Err(error) => {
            observe::<()>(report, op, Err(error));
        }
        Ok(()) => {
            report.set(
                op,
                Outcome::ProbeError {
                    reason: Reason::UnexpectedAcceptance,
                },
            );
        }
    }
}

fn pin(dir: &Dir) -> io::Result<Dir> {
    let mut options = OpenOptions::new();
    options
        .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(OPEN_FLAGS)
        .follow(FollowSymlinks::No);
    let file = dir.open_with(".", &options)?.into_std();
    check_kind(&file, true)?;
    Ok(Dir::from_std_file(file))
}
fn handle_path(handle: &impl AsRawHandle) -> io::Result<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            handle.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize >= buffer.len() {
        return Err(acl::error(Reason::BoundedBufferExceeded));
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..length as usize],
    )))
}
fn path_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn create_directory(path: &Path, sd: &acl::Local) -> io::Result<()> {
    acl::check(unsafe { CreateDirectoryW(path_wide(path).as_ptr(), &acl::attributes(sd)) })
}
fn open(path: &Path, writable: bool, create: Option<&acl::Local>) -> io::Result<File> {
    let attrs = create.map(acl::attributes);
    let access = if writable {
        GENERIC_READ | GENERIC_WRITE
    } else {
        READ_CONTROL | FILE_READ_ATTRIBUTES
    };
    let raw = unsafe {
        CreateFileW(
            path_wide(path).as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            attrs.as_ref().map_or(ptr::null(), |a| a),
            if create.is_some() {
                CREATE_NEW
            } else {
                OPEN_EXISTING
            },
            OPEN_FLAGS,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_handle(raw) })
    }
}
fn check_kind(handle: &impl AsRawHandle, directory: bool) -> io::Result<()> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    acl::check(unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut info) })?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(acl::error(Reason::UnexpectedFileType));
    }
    Ok(())
}
fn set_junction(handle: &File, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let target: Vec<u16> = target.as_os_str().encode_wide().collect();
    // GetFinalPathNameByHandleW with DOS volume naming yields \\?\... . Only
    // local drive targets in this run's fixture are supported; never use UNC.
    let prefix: Vec<u16> = "\\\\?\\".encode_utf16().collect();
    if !target.starts_with(&prefix) || target.get(5) != Some(&(b':' as u16)) {
        return Err(acl::error(Reason::UnexpectedFileType));
    }
    let substitute: Vec<u16> = "\\??\\"
        .encode_utf16()
        .chain(target[4..].iter().copied())
        .collect();
    let byte_length = substitute.len() * 2;
    // REPARSE_DATA_BUFFER mount-point header: 8 generic + 8 mount fields,
    // substitute UTF-16 NUL, then an empty print-name NUL. Bound before u16 cast.
    if byte_length + 12 > 16376 {
        return Err(acl::error(Reason::BoundedBufferExceeded));
    }
    let mut buffer = Vec::new();
    buffer.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer.extend(((byte_length + 12) as u16).to_le_bytes());
    buffer.extend(0u16.to_le_bytes());
    for value in [0, byte_length as u16, (byte_length + 2) as u16, 0] {
        buffer.extend(value.to_le_bytes());
    }
    for unit in substitute {
        buffer.extend(unit.to_le_bytes());
    }
    buffer.extend([0u8; 4]);
    let mut returned = 0;
    acl::check(unsafe {
        DeviceIoControl(
            handle.as_raw_handle(),
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            buffer.len() as u32,
            ptr::null_mut(),
            0,
            &mut returned,
            ptr::null_mut(),
        )
    })
}
fn cleanup(root: &Dir, created: &[(&str, bool)]) -> io::Result<()> {
    // All fixture handles have closed. Reverse-order, nonrecursive deletion of
    // only successfully created entries. A junction removal never follows it.
    for &(name, directory) in created.iter().rev() {
        if directory {
            root.remove_dir(name)?;
        } else {
            root.remove_file(name)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_expected_rejection_counts_as_a_negative_control() {
        let mut report = Report::windows();
        rejection(
            &mut report,
            Op::RejectBroadAclFile,
            Reason::UnexpectedAcl,
            Err(acl::error(Reason::UnexpectedAcl)),
        );
        assert!(report
            .operations
            .iter()
            .any(|r| r.operation == Op::RejectBroadAclFile
                && r.outcome
                    == Outcome::Rejected {
                        reason: Reason::UnexpectedAcl
                    }));
        rejection(
            &mut report,
            Op::RejectBroadAclFile,
            Reason::UnexpectedAcl,
            Err(io::Error::from_raw_os_error(5)),
        );
        assert!(report
            .operations
            .iter()
            .any(|r| r.operation == Op::RejectBroadAclFile
                && r.outcome == Outcome::Win32Error { code: 5 }));
        rejection(
            &mut report,
            Op::RejectBroadAclFile,
            Reason::UnexpectedAcl,
            Ok(()),
        );
        assert!(report
            .operations
            .iter()
            .any(|r| r.operation == Op::RejectBroadAclFile
                && r.outcome
                    == Outcome::ProbeError {
                        reason: Reason::UnexpectedAcceptance
                    }));
    }
}
