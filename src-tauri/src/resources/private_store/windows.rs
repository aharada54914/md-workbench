//! Local NTFS storage; all reconstructed-path ancestors remain pinned without DELETE sharing.
use super::{windows_acl as acl, Operation as Op, Policy, StoreError};
use std::{
    ffi::OsString,
    fs::File,
    io, mem,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    ptr,
};
use windows_sys::Win32::{
    Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
    Storage::FileSystem::*,
    System::{
        Com::CoTaskMemFree,
        SystemServices::{FILE_PERSISTENT_ACLS, FILE_READ_ONLY_VOLUME},
        WindowsProgramming::DRIVE_FIXED,
    },
    UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath},
};
const JOURNAL: &str = "journal.v1";
const PREFIX: &str = "mdw-private-journal-";
const FLAGS: u32 = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn err(op: Op, error: io::Error) -> StoreError {
    if error.raw_os_error() == Some(32) || error.raw_os_error() == Some(33) {
        return StoreError::Busy;
    }
    if let Some(reason) = error
        .get_ref()
        .and_then(|e| e.downcast_ref::<acl::Reason>())
    {
        return StoreError::WindowsSecurity {
            operation: op,
            reason: *reason,
        };
    }
    StoreError::io(op, error)
}
fn open(path: &Path, access: u32, share: u32, create: Option<&acl::Local>) -> io::Result<File> {
    let attrs = create.map(acl::attributes);
    let raw = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            access,
            share,
            attrs.as_ref().map_or(ptr::null(), |v| v),
            if create.is_some() {
                CREATE_NEW
            } else {
                OPEN_EXISTING
            },
            FLAGS,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_handle(raw) })
    }
}
fn info(file: &File, directory: bool) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut value = unsafe { mem::zeroed() };
    acl::check(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut value) })?;
    let value: BY_HANDLE_FILE_INFORMATION = value;
    if value.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (value.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && value.nNumberOfLinks != 1)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "private storage type",
        ));
    }
    Ok(value)
}
fn identity(file: &File, directory: bool) -> io::Result<(u32, u32, u32)> {
    let v = info(file, directory)?;
    Ok((v.dwVolumeSerialNumber, v.nFileIndexHigh, v.nFileIndexLow))
}
fn handle_path(file: &File) -> io::Result<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    let n = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if n == 0 {
        return Err(io::Error::last_os_error());
    }
    if n as usize >= buffer.len() {
        return Err(acl::error(acl::Reason::BoundedBufferExceeded));
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..n as usize])))
}
fn base_path() -> Result<PathBuf, StoreError> {
    let mut raw = ptr::null_mut();
    let hr = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, ptr::null_mut(), &mut raw) };
    struct Memory(*mut u16);
    impl Drop for Memory {
        fn drop(&mut self) {
            unsafe {
                CoTaskMemFree(self.0.cast());
            }
        }
    }
    let value = Memory(raw);
    if hr < 0 {
        return Err(StoreError::Io {
            operation: Op::ResolveBase,
            code: Some(hr),
        });
    }
    if value.0.is_null() {
        return Err(StoreError::Unsafe {
            reason: Policy::Identity,
        });
    }
    for n in 0..32768 {
        if unsafe { *value.0.add(n) } == 0 {
            return Ok(PathBuf::from(OsString::from_wide(unsafe {
                std::slice::from_raw_parts(value.0, n)
            })));
        }
    }
    Err(StoreError::LimitExceeded)
}
fn account_base(writable: bool) -> Result<Vec<File>, StoreError> {
    let path = base_path()?;
    let mut components = path.components();
    let drive = match components.next() {
        Some(Component::Prefix(p)) => match p.kind() {
            Prefix::Disk(d) => d,
            _ => {
                return Err(StoreError::Unsupported {
                    reason: Policy::Filesystem,
                })
            }
        },
        _ => {
            return Err(StoreError::Unsafe {
                reason: Policy::Identity,
            })
        }
    };
    if components.next() != Some(Component::RootDir) {
        return Err(StoreError::Unsafe {
            reason: Policy::Identity,
        });
    }
    let volume = PathBuf::from(format!("{}:\\", char::from(drive)));
    if unsafe { GetDriveTypeW(wide(&volume).as_ptr()) } != DRIVE_FIXED {
        return Err(StoreError::Unsupported {
            reason: Policy::Filesystem,
        });
    }
    let remaining: Vec<_> = components.collect();
    let mut current = volume;
    let mut pins = Vec::new();
    let first = open(
        &current,
        READ_CONTROL | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        None,
    )
    .map_err(|e| err(Op::ResolveBase, e))?;
    info(&first, true).map_err(|e| err(Op::Inspect, e))?;
    pins.push(first);
    for (index, component) in remaining.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(StoreError::Unsafe {
                reason: Policy::Identity,
            });
        };
        current.push(name);
        let access = if writable && index + 1 == remaining.len() {
            GENERIC_READ | GENERIC_WRITE
        } else {
            READ_CONTROL | FILE_READ_ATTRIBUTES
        };
        let file = open(&current, access, FILE_SHARE_READ | FILE_SHARE_WRITE, None)
            .map_err(|e| err(Op::ResolveBase, e))?;
        info(&file, true).map_err(|e| err(Op::Inspect, e))?;
        pins.push(file);
    }
    filesystem(pins.last().unwrap())?;
    Ok(pins)
}
fn filesystem(file: &File) -> Result<(), StoreError> {
    let mut name = [0u16; 32];
    let mut flags = 0;
    acl::check(unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut flags,
            name.as_mut_ptr(),
            name.len() as u32,
        )
    })
    .map_err(|e| err(Op::Inspect, e))?;
    let n = name
        .iter()
        .position(|&v| v == 0)
        .ok_or(StoreError::LimitExceeded)?;
    if String::from_utf16_lossy(&name[..n]) != "NTFS"
        || flags & FILE_PERSISTENT_ACLS == 0
        || flags & FILE_READ_ONLY_VOLUME != 0
    {
        return Err(StoreError::Unsupported {
            reason: Policy::Filesystem,
        });
    }
    Ok(())
}
pub(super) fn check_file(file: &File) -> io::Result<()> {
    info(file, false)?;
    let user = acl::identity()?;
    acl::inspect(file, &user.sid, false)
}
pub(super) fn flush_file(file: &File) -> io::Result<()> {
    acl::check(unsafe { FlushFileBuffers(file.as_raw_handle()) })
}
pub(super) struct Root {
    parents: Vec<File>,
    dir: File,
    id: String,
    user: String,
    created: bool,
    snapshot_identity: Option<snapshot_native::OwnedSnapshot>,
    file_identity: Option<(u32, u32, u32)>,
}
impl Root {
    pub(super) fn identifier(&self) -> &str {
        &self.id
    }
    pub(super) fn create() -> Result<(Self, File), StoreError> {
        let user = acl::identity().map_err(|e| err(Op::QueryIdentity, e))?.sid;
        let parents = account_base(true)?;
        let id = uuid::Uuid::new_v4().to_string();
        let path = handle_path(parents.last().unwrap())
            .map_err(|e| err(Op::Inspect, e))?
            .join(format!("{PREFIX}{id}"));
        let sd =
            acl::descriptor(&acl::private_sddl(&user, true)).map_err(|e| err(Op::CreateRoot, e))?;
        acl::check(unsafe { CreateDirectoryW(wide(&path).as_ptr(), &acl::attributes(&sd)) })
            .map_err(|e| err(Op::CreateRoot, e))?;
        let mut root = Self::open(parents, id, user, true)?;
        let sd = acl::descriptor(&acl::private_sddl(&root.user, false))
            .map_err(|e| err(Op::CreateFile, e))?;
        let file = open(
            &root.path()?.join(JOURNAL),
            GENERIC_READ | GENERIC_WRITE | DELETE,
            0,
            Some(&sd),
        )
        .map_err(|e| err(Op::CreateFile, e))?;
        check_file(&file).map_err(|e| err(Op::InspectFile, e))?;
        root.file_identity = Some(identity(&file, false).map_err(|e| err(Op::Inspect, e))?);
        #[cfg(feature = "private-store-probe")]
        super::probe::notify(super::probe::Boundary::Bootstrap, Some(&root.id));
        flush_file(&file).map_err(|e| err(Op::FlushFile, e))?;
        flush_file(&root.dir).map_err(|e| err(Op::FlushRoot, e))?;
        flush_file(root.parents.last().unwrap()).map_err(|e| err(Op::FlushParent, e))?;
        Ok((root, file))
    }
    pub(super) fn existing(id: &str) -> Result<Self, StoreError> {
        if uuid::Uuid::parse_str(id)
            .ok()
            .filter(|v| !v.is_nil() && v.to_string() == id)
            .is_none()
        {
            return Err(StoreError::Unsafe {
                reason: Policy::Identity,
            });
        }
        let user = acl::identity().map_err(|e| err(Op::QueryIdentity, e))?.sid;
        Self::open(account_base(false)?, id.to_owned(), user, false)
    }
    fn open(
        parents: Vec<File>,
        id: String,
        user: String,
        created: bool,
    ) -> Result<Self, StoreError> {
        let path = handle_path(parents.last().unwrap())
            .map_err(|e| err(Op::Inspect, e))?
            .join(format!("{PREFIX}{id}"));
        let access = if created {
            GENERIC_READ | GENERIC_WRITE
        } else {
            GENERIC_READ
        };
        let dir = open(&path, access, FILE_SHARE_READ | FILE_SHARE_WRITE, None)
            .map_err(|e| err(Op::Inspect, e))?;
        info(&dir, true).map_err(|e| err(Op::Inspect, e))?;
        acl::inspect(&dir, &user, true).map_err(|e| err(Op::InspectRoot, e))?;
        filesystem(&dir)?;
        Ok(Self {
            parents,
            dir,
            id,
            user,
            created,
            file_identity: None,
            snapshot_identity: None,
        })
    }
    fn path(&self) -> Result<PathBuf, StoreError> {
        handle_path(&self.dir).map_err(|e| err(Op::Inspect, e))
    }
    fn file(&self, delete: bool) -> Result<File, StoreError> {
        let file = open(
            &self.path()?.join(JOURNAL),
            GENERIC_READ | if delete { DELETE } else { 0 },
            0,
            None,
        )
        .map_err(|e| err(Op::Read, e))?;
        check_file(&file).map_err(|e| err(Op::InspectFile, e))?;
        if self
            .file_identity
            .is_some_and(|v| identity(&file, false).ok() != Some(v))
        {
            return Err(StoreError::Unsafe {
                reason: Policy::Changed,
            });
        }
        Ok(file)
    }
    pub(super) fn open_file(&self) -> Result<File, StoreError> {
        self.file(false)
    }
    pub(super) fn cleanup(self) -> Result<(), StoreError> {
        if !self.created {
            return Err(StoreError::Unsafe {
                reason: Policy::Identity,
            });
        }
        let file = self.file(true)?;
        self.cleanup_snapshot()?;
        delete_handle(&file)?;
        drop(file);
        let path = self.path()?;
        let expected = identity(&self.dir, true).map_err(|e| err(Op::Cleanup, e))?;
        drop(self.dir);
        // Upgrade only after releasing our no-delete pin, then compare the new
        // retained handle before deletion; never delete by an unchecked path.
        let dir = open(
            &path,
            GENERIC_READ | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
        )
        .map_err(|e| err(Op::Cleanup, e))?;
        if identity(&dir, true).map_err(|e| err(Op::Cleanup, e))? != expected {
            return Err(StoreError::Unsafe {
                reason: Policy::Changed,
            });
        }
        delete_handle(&dir)
    }
}
fn delete_handle(file: &File) -> Result<(), StoreError> {
    let value = FILE_DISPOSITION_INFO { DeleteFile: true };
    acl::check(unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&value as *const FILE_DISPOSITION_INFO).cast(),
            mem::size_of_val(&value) as u32,
        )
    })
    .map_err(|e| err(Op::Cleanup, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn security_errors_keep_the_operation_and_exact_reason() {
        for operation in [Op::QueryIdentity, Op::InspectRoot, Op::InspectFile] {
            for reason in [acl::Reason::PrivilegedToken, acl::Reason::UnexpectedAcl] {
                assert_eq!(
                    err(operation, acl::error(reason)),
                    StoreError::WindowsSecurity { operation, reason }
                );
            }
        }
        let json = serde_json::to_value(err(
            Op::QueryIdentity,
            acl::error(acl::Reason::PrivilegedToken),
        ))
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind":"windows_security", "operation":"query_identity", "reason":"privileged_token"})
        );
        assert_eq!(
            err(Op::FlushFile, io::Error::from_raw_os_error(5)),
            StoreError::Io {
                operation: Op::FlushFile,
                code: Some(5)
            }
        );
    }
}

#[path = "windows_snapshot.rs"]
mod snapshot_native;
