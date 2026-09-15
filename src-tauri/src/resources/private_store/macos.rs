//! FD-relative APFS storage. Advisory locking does not isolate hostile same-user code.
use super::{Operation as Op, Policy, StoreError};
use libc::*;
use std::{
    ffi::{c_void, CStr, CString},
    fs::File,
    io, mem,
    os::fd::{AsRawFd, FromRawFd},
    os::unix::ffi::OsStrExt,
    path::{Component, Path},
};
const JOURNAL: &str = "journal.v1";
const PREFIX: &str = "mdw-private-journal-";
const FILESEC_ACL: i32 = 5;
const ACL_NEXT_ENTRY: i32 = -1;
const ACL_EXTENDED_DENY: u32 = 2;
unsafe extern "C" {
    fn filesec_init() -> *mut c_void;
    fn filesec_free(value: *mut c_void);
    fn filesec_query_property(value: *mut c_void, property: i32, present: *mut i32) -> i32;
    fn filesec_get_property(value: *mut c_void, property: i32, out: *mut c_void) -> i32;
    #[cfg_attr(target_arch = "x86_64", link_name = "fstatx_np$INODE64")]
    fn fstatx_np(fd: i32, stat: *mut libc::stat, security: *mut c_void) -> i32;
    fn acl_get_entry(acl: *mut c_void, entry_id: i32, entry: *mut *mut c_void) -> i32;
    fn acl_get_tag_type(entry: *mut c_void, tag: *mut u32) -> i32;
    fn acl_free(value: *mut c_void) -> i32;
}
struct Acl(*mut c_void);
impl Drop for Acl {
    fn drop(&mut self) {
        unsafe {
            acl_free(self.0);
        }
    }
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "private storage policy")
}
fn c(value: &[u8]) -> io::Result<CString> {
    CString::new(value).map_err(|_| invalid())
}
fn cv(value: i32) -> io::Result<()> {
    if value == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn stat(file: &File) -> io::Result<libc::stat> {
    let mut s = unsafe { mem::zeroed() };
    cv(unsafe { fstat(file.as_raw_fd(), &mut s) })?;
    Ok(s)
}
fn acl_check(file: &File, private: bool) -> io::Result<()> {
    // Unlike acl_get_fd_np's ambiguous NULL/ENOENT, query absence only after
    // a successful security/stat read from this live descriptor.
    struct Security(*mut c_void);
    impl Drop for Security {
        fn drop(&mut self) {
            unsafe {
                filesec_free(self.0);
            }
        }
    }
    let security = Security(unsafe { filesec_init() });
    if security.0.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut metadata = unsafe { mem::zeroed() };
    cv(unsafe { fstatx_np(file.as_raw_fd(), &mut metadata, security.0) })?;
    let mut present = 0;
    cv(unsafe { filesec_query_property(security.0, FILESEC_ACL, &mut present) })?;
    if present == 0 {
        return Ok(());
    }
    let mut acl = Acl(std::ptr::null_mut());
    cv(unsafe {
        filesec_get_property(
            security.0,
            FILESEC_ACL,
            (&mut acl.0 as *mut *mut c_void).cast(),
        )
    })?;
    if acl.0.is_null() || acl.0 as usize == usize::MAX {
        acl.0 = std::ptr::null_mut();
        return Err(invalid());
    }
    let mut entry = std::ptr::null_mut();
    for index in 0..256 {
        let ret = unsafe {
            acl_get_entry(
                acl.0,
                if index == 0 { 0 } else { ACL_NEXT_ENTRY },
                &mut entry,
            )
        };
        if ret == -1 {
            let error = io::Error::last_os_error();
            // Darwin documents EINVAL at end of the OS-returned ACL.

            return if error.raw_os_error() == Some(EINVAL) {
                Ok(())
            } else {
                Err(error)
            };
        }
        let mut tag = 0;
        cv(unsafe { acl_get_tag_type(entry, &mut tag) })?;
        if private || tag != ACL_EXTENDED_DENY {
            return Err(invalid());
        }
    }
    Err(invalid())
}
fn inspect(file: &File, directory: bool, private: bool) -> io::Result<()> {
    let s = stat(file)?;
    let uid = unsafe { geteuid() };
    let kind = if directory { S_IFDIR } else { S_IFREG };
    if s.st_mode & S_IFMT != kind || (!directory && s.st_nlink != 1) {
        return Err(invalid());
    }
    if private {
        if s.st_uid != uid || s.st_mode & 0o7777 != if directory { 0o700 } else { 0o600 } {
            return Err(invalid());
        }
    } else if (s.st_uid != uid && s.st_uid != 0) || s.st_mode & 0o022 != 0 {
        return Err(invalid());
    }
    acl_check(file, private)
}
fn open_at(parent: &File, name: &[u8], flags: i32, mode: u16) -> io::Result<File> {
    let name = c(name)?;
    let fd = unsafe {
        openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | O_NOFOLLOW | O_CLOEXEC,
            mode as c_uint,
        )
    };
    if fd == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn account_base() -> Result<Vec<File>, StoreError> {
    let uid = unsafe { getuid() };
    if uid == 0 || uid != unsafe { geteuid() } {
        return Err(StoreError::Unsafe {
            reason: Policy::Identity,
        });
    }
    let mut buffer = vec![0u8; 65536];
    let mut pwd: passwd = unsafe { mem::zeroed() };
    let mut result = std::ptr::null_mut();
    let code = unsafe {
        getpwuid_r(
            uid,
            &mut pwd,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if code != 0 {
        return Err(StoreError::Io {
            operation: Op::ResolveBase,
            code: Some(code),
        });
    }
    if result.is_null() || pwd.pw_dir.is_null() {
        return Err(StoreError::Unsafe {
            reason: Policy::Identity,
        });
    }
    let home = unsafe { CStr::from_ptr(pwd.pw_dir) }.to_bytes();
    let base = Path::new(std::ffi::OsStr::from_bytes(home)).join("Library/Application Support");
    if !base.is_absolute() {
        return Err(StoreError::Unsafe {
            reason: Policy::Identity,
        });
    }
    let fd = unsafe {
        open(
            c"/".as_ptr(),
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
        )
    };
    if fd == -1 {
        return Err(StoreError::io(Op::ResolveBase, io::Error::last_os_error()));
    }
    let mut parents = vec![unsafe { File::from_raw_fd(fd) }];
    for component in base.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                let f = open_at(
                    parents.last().unwrap(),
                    name.as_bytes(),
                    O_RDONLY | O_DIRECTORY,
                    0,
                )
                .map_err(|e| StoreError::io(Op::ResolveBase, e))?;
                inspect(&f, true, false).map_err(|_| StoreError::Unsafe {
                    reason: Policy::Permissions,
                })?;
                parents.push(f);
            }
            _ => {
                return Err(StoreError::Unsafe {
                    reason: Policy::Identity,
                })
            }
        }
    }
    filesystem(parents.last().unwrap())?;
    Ok(parents)
}
fn filesystem(file: &File) -> Result<(), StoreError> {
    let mut s: statfs = unsafe { mem::zeroed() };
    cv(unsafe { fstatfs(file.as_raw_fd(), &mut s) }).map_err(|e| StoreError::io(Op::Inspect, e))?;
    let name = unsafe { CStr::from_ptr(s.f_fstypename.as_ptr()) }.to_bytes();
    if name != b"apfs" || s.f_flags & MNT_LOCAL as u32 == 0 || s.f_flags & MNT_RDONLY as u32 != 0 {
        return Err(StoreError::Unsupported {
            reason: Policy::Filesystem,
        });
    }
    Ok(())
}
fn same(a: &File, b: &File) -> io::Result<bool> {
    let a = stat(a)?;
    let b = stat(b)?;
    Ok((a.st_dev, a.st_ino) == (b.st_dev, b.st_ino))
}
fn barrier(file: &File, op: Op) -> Result<(), StoreError> {
    cv(unsafe { fsync(file.as_raw_fd()) }).map_err(|e| StoreError::io(op, e))
}
pub(super) fn check_file(file: &File) -> io::Result<()> {
    inspect(file, false, true)
}
pub(super) fn flush_file(file: &File) -> io::Result<()> {
    cv(unsafe { fsync(file.as_raw_fd()) })?;
    cv(unsafe { fcntl(file.as_raw_fd(), F_FULLFSYNC) })
}
pub(super) struct Root {
    parents: Vec<File>,
    dir: File,
    id: String,
    created: bool,
    snapshot_identity: Option<snapshot_native::OwnedSnapshot>,
    file_identity: Option<(dev_t, ino_t)>,
}
impl Root {
    pub(super) fn identifier(&self) -> &str {
        &self.id
    }
    pub(super) fn create() -> Result<(Self, File), StoreError> {
        let parents = account_base()?;
        let id = uuid::Uuid::new_v4().to_string();
        let name = c(format!("{PREFIX}{id}").as_bytes()).unwrap();
        cv(unsafe { mkdirat(parents.last().unwrap().as_raw_fd(), name.as_ptr(), 0o700) })
            .map_err(|e| StoreError::io(Op::CreateRoot, e))?;
        let mut root = Self::open(parents, id, true)?;
        let file = open_at(
            &root.dir,
            JOURNAL.as_bytes(),
            O_RDWR | O_CREAT | O_EXCL,
            0o600,
        )
        .map_err(|e| StoreError::io(Op::CreateFile, e))?;
        check_file(&file).map_err(|_| StoreError::Unsafe {
            reason: Policy::Permissions,
        })?;
        let s = stat(&file).map_err(|e| StoreError::io(Op::Inspect, e))?;
        root.file_identity = Some((s.st_dev, s.st_ino));
        if s.st_dev
            != stat(&root.dir)
                .map_err(|e| StoreError::io(Op::Inspect, e))?
                .st_dev
        {
            return Err(StoreError::Unsafe {
                reason: Policy::Filesystem,
            });
        }
        cv(unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) })
            .map_err(|e| StoreError::io(Op::Lock, e))?;
        #[cfg(feature = "private-store-probe")]
        super::probe::notify(super::probe::Boundary::Bootstrap, Some(&root.id));
        flush_file(&file).map_err(|e| StoreError::io(Op::FlushFile, e))?;
        barrier(&root.dir, Op::FlushRoot)?;
        barrier(root.parents.last().unwrap(), Op::FlushParent)?;
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
        Self::open(account_base()?, id.to_owned(), false)
    }
    fn open(parents: Vec<File>, id: String, created: bool) -> Result<Self, StoreError> {
        let dir = open_at(
            parents.last().unwrap(),
            format!("{PREFIX}{id}").as_bytes(),
            O_RDONLY | O_DIRECTORY,
            0,
        )
        .map_err(|e| StoreError::io(Op::Inspect, e))?;
        inspect(&dir, true, true).map_err(|_| StoreError::Unsafe {
            reason: Policy::Permissions,
        })?;
        filesystem(&dir)?;
        if stat(&dir)
            .map_err(|e| StoreError::io(Op::Inspect, e))?
            .st_dev
            != stat(parents.last().unwrap())
                .map_err(|e| StoreError::io(Op::Inspect, e))?
                .st_dev
        {
            return Err(StoreError::Unsafe {
                reason: Policy::Filesystem,
            });
        }
        Ok(Self {
            parents,
            dir,
            id,
            created,
            file_identity: None,
            snapshot_identity: None,
        })
    }
    pub(super) fn open_file(&self) -> Result<File, StoreError> {
        let file = open_at(&self.dir, JOURNAL.as_bytes(), O_RDONLY | O_NONBLOCK, 0)
            .map_err(|e| StoreError::io(Op::Read, e))?;
        check_file(&file).map_err(|_| StoreError::Unsafe {
            reason: Policy::Permissions,
        })?;
        let s = stat(&file).map_err(|e| StoreError::io(Op::Inspect, e))?;
        if self
            .file_identity
            .is_some_and(|v| v != (s.st_dev, s.st_ino))
            || s.st_dev
                != stat(&self.dir)
                    .map_err(|e| StoreError::io(Op::Inspect, e))?
                    .st_dev
        {
            return Err(StoreError::Unsafe {
                reason: Policy::Changed,
            });
        }
        cv(unsafe { flock(file.as_raw_fd(), LOCK_SH | LOCK_NB) })
            .map_err(|e| StoreError::io(Op::Lock, e))?;
        Ok(file)
    }
    pub(super) fn cleanup(self) -> Result<(), StoreError> {
        if !self.created {
            return Err(StoreError::Unsafe {
                reason: Policy::Identity,
            });
        }
        let file = self.open_file()?;
        self.cleanup_snapshot()?;
        drop(file);
        let name = format!("{PREFIX}{}", self.id);
        let current = open_at(
            self.parents.last().unwrap(),
            name.as_bytes(),
            O_RDONLY | O_DIRECTORY,
            0,
        )
        .map_err(|e| StoreError::io(Op::Cleanup, e))?;
        if !same(&current, &self.dir).map_err(|e| StoreError::io(Op::Cleanup, e))? {
            return Err(StoreError::Unsafe {
                reason: Policy::Changed,
            });
        }
        // Nonrecursive cleanup, only the exclusive-created synthetic entries.
        cv(unsafe {
            unlinkat(
                self.dir.as_raw_fd(),
                c(JOURNAL.as_bytes()).unwrap().as_ptr(),
                0,
            )
        })
        .map_err(|e| StoreError::io(Op::Cleanup, e))?;
        cv(unsafe {
            unlinkat(
                self.parents.last().unwrap().as_raw_fd(),
                c(name.as_bytes()).unwrap().as_ptr(),
                AT_REMOVEDIR,
            )
        })
        .map_err(|e| StoreError::io(Op::Cleanup, e))
    }
}

#[cfg(test)]
#[path = "macos_tests.rs"]
mod tests;

#[path = "macos_snapshot.rs"]
mod snapshot_native;
