use crate::report::{Filesystem, Operation, Outcome, Reason, Report};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, MetadataExt, OpenOptions, OpenOptionsExt};
use std::io::{self, Write};
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
use windows_sys::Win32::Storage::FileSystem::{
    FlushFileBuffers, GetVolumeInformationByHandleW, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

const CHILD: &str = "child";
const FILE: &str = "probe.bin";
const FIXTURE_BYTES: &[u8] = b"\xef\xbb\xbfstorage-probe\r\n";

#[derive(Default)]
struct Created {
    child_created: bool,
    file_created: bool,
}

pub fn run() -> Report {
    let mut report = Report::windows();
    let Some(parent) = observe(
        &mut report,
        Operation::OpenTempParent,
        Dir::open_ambient_dir(std::env::temp_dir(), cap_std::ambient_authority()),
    ) else {
        return report;
    };
    // A random exclusive child prevents touching an existing fixture. Collision is
    // reported, with no retry or deletion of the entry we did not create.
    let name = format!("mdw-storage-probe-{}", uuid::Uuid::new_v4());
    if observe(
        &mut report,
        Operation::CreateFixture,
        parent.create_dir(&name),
    )
    .is_none()
    {
        return report;
    }
    let root = observe(
        &mut report,
        Operation::OpenReadonlyDirectory,
        parent.open_dir_nofollow(&name).and_then(check_directory),
    );
    let mut created = Created::default();
    if let Some(root) = &root {
        exercise(&parent, &name, root, &mut created, &mut report);
    }
    let result = cleanup(&parent, &name, root, created);
    observe(&mut report, Operation::Cleanup, result);
    report
}

fn exercise(parent: &Dir, name: &str, root: &Dir, created: &mut Created, report: &mut Report) {
    let Some(filesystem) = observe(report, Operation::QueryFilesystem, query_filesystem(root))
    else {
        return;
    };
    let is_ntfs = filesystem.filesystem_type.eq_ignore_ascii_case("NTFS");
    report.filesystem = Some(filesystem);
    if !is_ntfs {
        report.skip_remaining(Reason::NonNtfs);
        return;
    }

    crate::windows_acl_fixtures::run(root, report);

    // This read-only cap-std handle is the baseline even when its flush fails.
    observe(report, Operation::FlushReadonlyDirectory, flush(root));
    let writable_root = observe(
        report,
        Operation::OpenReadwriteDirectory,
        open_writable_directory(parent, name),
    );
    created.child_created = observe(
        report,
        Operation::CreateChildDirectory,
        root.create_dir(CHILD),
    )
    .is_some();
    let child = if created.child_created {
        observe(
            report,
            Operation::OpenReadwriteChild,
            open_writable_directory(root, CHILD),
        )
    } else {
        None
    };

    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .follow(FollowSymlinks::No);
    // File creation/flush is an independent control experiment. A rejected RW
    // directory open must not suppress it or be relabeled as successful.
    let file = root.open_with(FILE, &options);
    // Remember creation before write_all: even a partial write needs cleanup.
    if file.is_ok() {
        created.file_created = true;
    }
    let file = file.and_then(|mut file| {
        file.write_all(FIXTURE_BYTES)?;
        Ok(file)
    });
    if let Some(file) = observe(report, Operation::WriteFile, file) {
        observe(report, Operation::FlushFile, flush(&file));
    }
    // Record the two namespace flushes independently of the file's flush result.
    if let Some(child) = &child {
        observe(report, Operation::FlushChildDirectory, flush(child));
    }
    if let Some(writable_root) = &writable_root {
        observe(
            report,
            Operation::FlushParentDirectory,
            flush(writable_root),
        );
    }
}

fn open_writable_directory(parent: &Dir, name: &str) -> io::Result<Dir> {
    let mut options = OpenOptions::new();
    options
        .access_mode(GENERIC_READ | GENERIC_WRITE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .follow(FollowSymlinks::No);
    let file = parent.open_with(name, &options)?;
    check_directory(Dir::from_std_file(file.into_std()))
}

fn check_directory(dir: Dir) -> io::Result<Dir> {
    let metadata = dir.dir_metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            Reason::UnexpectedFileType,
        ));
    }
    Ok(dir)
}

fn flush(handle: &impl AsRawHandle) -> io::Result<()> {
    // SAFETY: the borrowed owning object keeps a live handle for the entire call.
    if unsafe { FlushFileBuffers(handle.as_raw_handle()) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn query_filesystem(dir: &Dir) -> io::Result<Filesystem> {
    let mut name = [0u16; 32];
    let mut flags = 0;
    let mut max_component_length = 0;
    // SAFETY: all non-null outputs are live, writable and correctly sized. We
    // deliberately omit volume label and serial number from both call and output.
    let ok = unsafe {
        GetVolumeInformationByHandleW(
            dir.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut max_component_length,
            &mut flags,
            name.as_mut_ptr(),
            name.len() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let end = name.iter().position(|&c| c == 0).unwrap_or(name.len());
    let filesystem_type = String::from_utf16(&name[..end])
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, Reason::InvalidFilesystemName))?;
    if filesystem_type.is_empty()
        || !filesystem_type
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            Reason::InvalidFilesystemName,
        ));
    }
    Ok(Filesystem {
        filesystem_type,
        flags,
        max_component_length,
    })
}

pub(crate) fn observe<T>(
    report: &mut Report,
    operation: Operation,
    result: io::Result<T>,
) -> Option<T> {
    match result {
        Ok(value) => {
            report.set(operation, Outcome::Success);
            Some(value)
        }
        Err(error) => {
            let outcome = if let Some(code) = error.raw_os_error() {
                Outcome::Win32Error { code: code as u32 }
            } else {
                // Never serialize arbitrary io::Error messages (which can contain paths).
                let reason = error
                    .get_ref()
                    .and_then(|e| e.downcast_ref::<Reason>())
                    .copied()
                    .unwrap_or(Reason::IoWithoutWin32Code);
                Outcome::ProbeError { reason }
            };
            report.set(operation, outcome);
            None
        }
    }
}

fn cleanup(parent: &Dir, name: &str, root: Option<Dir>, created: Created) -> io::Result<()> {
    // Nonrecursive removal of only entries created by this run. No ambient-path
    // remove_dir_all fallback; failures leave a disposable fixture and are reported.
    if created.file_created {
        if let Some(root) = &root {
            root.remove_file(FILE)?;
        }
    }
    if created.child_created {
        if let Some(root) = &root {
            root.remove_dir(CHILD)?;
        }
    }
    drop(root);
    parent.remove_dir(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_win32_errors_and_typed_reasons_are_preserved_without_messages() {
        let mut report = Report::windows();
        let result: Option<()> = observe(
            &mut report,
            Operation::FlushFile,
            Err(io::Error::from_raw_os_error(5)),
        );
        assert!(result.is_none());
        assert_eq!(
            report.operations[9].outcome,
            Outcome::Win32Error { code: 5 }
        );
        let _: Option<()> = observe(
            &mut report,
            Operation::QueryFilesystem,
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                Reason::InvalidFilesystemName,
            )),
        );
        assert_eq!(
            report.operations[3].outcome,
            Outcome::ProbeError {
                reason: Reason::InvalidFilesystemName
            }
        );
        let _: Option<()> = observe(
            &mut report,
            Operation::WriteFile,
            Err(io::Error::other("C:\\Users\\private\\secret")),
        );
        assert_eq!(
            report.operations[8].outcome,
            Outcome::ProbeError {
                reason: Reason::IoWithoutWin32Code
            }
        );
        assert!(!String::from_utf8(report.to_json().unwrap())
            .unwrap()
            .contains("secret"));
    }

    #[test]
    fn reported_handle_flags_match_native_constants_and_exclude_delete_sharing() {
        let json: serde_json::Value =
            serde_json::from_slice(&Report::windows().to_json().unwrap()).unwrap();
        assert_eq!(json["directory_access"], GENERIC_READ | GENERIC_WRITE);
        assert_eq!(json["directory_share"], FILE_SHARE_READ | FILE_SHARE_WRITE);
        assert_eq!(
            json["directory_flags"],
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
        );
        assert_eq!(
            json["directory_share"].as_u64().unwrap()
                & u64::from(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE),
            0
        );
    }
}
