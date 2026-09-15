//! Reveal is a narrow OS handoff, not a filesystem path-authority getter.
//! The manager resolves paths after dispatch; external substitutions after our
//! last comparison remain possible. No document I/O may use this adapter.
use super::*;
use std::fs::File;

#[derive(Debug, PartialEq, Eq)]
struct Identity(u64, [u8; 16]);

fn identity(file: &File) -> Result<Identity, AccessError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        let mut file_id = [0; 16];
        file_id[..8].copy_from_slice(&metadata.ino().to_le_bytes());
        return Ok(Identity(metadata.dev(), file_id));
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED};
        use windows_sys::Win32::Storage::FileSystem::{
            FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
        };
        let mut info = FILE_ID_INFO::default();
        // SAFETY: the live File owns this handle and info is a correctly sized,
        // writable output buffer. Failure does not leave usable identity data.
        // FileIdInfo preserves the full 128-bit identity, including on ReFS.
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdInfo,
                (&mut info as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if matches!(
                error.raw_os_error().map(|code| code as u32),
                Some(ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED)
            ) {
                return Err(AccessError::UnsupportedPlatform);
            }
            return Err(error.into());
        }
        return Ok(Identity(info.VolumeSerialNumber, info.FileId.Identifier));
    }
    #[allow(unreachable_code)]
    Err(AccessError::UnsupportedPlatform)
}

fn regular_kind(metadata: &cap_std::fs::Metadata) -> Result<bool, AccessError> {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AccessError::InvalidPath);
        }
    }
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err(AccessError::InvalidPath);
    }
    Ok(metadata.is_dir())
}

// Keep every opened directory alive until dispatch. Comparing the parent chain
// also rejects a substituted parent that happens to contain a hard-linked leaf.
struct OpenedTarget {
    directories: Vec<Dir>,
    file: Option<File>,
}
impl OpenedTarget {
    fn open(directory: Dir, relative: &Path, exact_file: bool) -> Result<Self, AccessError> {
        if !regular_kind(&directory.dir_metadata()?)? {
            return Err(AccessError::InvalidPath);
        }
        let mut opened = Self {
            directories: vec![directory],
            file: None,
        };
        if relative.as_os_str().is_empty() {
            return if exact_file {
                Err(AccessError::InvalidPath)
            } else {
                Ok(opened)
            };
        }
        validate_relative(relative)?;
        let mut names = relative.components().peekable();
        while let Some(Component::Normal(name)) = names.next() {
            let parent = opened.directories.last().ok_or(AccessError::InvalidPath)?;
            if names.peek().is_some() {
                let child = parent.open_dir_nofollow(name)?;
                if !regular_kind(&child.dir_metadata()?)? {
                    return Err(AccessError::InvalidPath);
                }
                opened.directories.push(child);
                continue;
            }
            let is_directory = regular_kind(&parent.symlink_metadata(name)?)?;
            if is_directory {
                if exact_file {
                    return Err(AccessError::InvalidPath);
                }
                let child = parent.open_dir_nofollow(name)?;
                if !regular_kind(&child.dir_metadata()?)? {
                    return Err(AccessError::InvalidPath);
                }
                opened.directories.push(child);
            } else {
                let mut options = OpenOptions::new();
                options.read(true).follow(FollowSymlinks::No).nonblock(true);
                let file = parent.open_with(name, &options)?;
                if regular_kind(&file.metadata()?)? {
                    return Err(AccessError::InvalidPath);
                }
                opened.file = Some(file.into_std());
            }
        }
        Ok(opened)
    }
    fn same_as(&self, other: &Self) -> Result<bool, AccessError> {
        if self.directories.len() != other.directories.len() {
            return Ok(false);
        }
        for (left, right) in self.directories.iter().zip(&other.directories) {
            if identity(&left.try_clone()?.into_std_file())?
                != identity(&right.try_clone()?.into_std_file())?
            {
                return Ok(false);
            }
        }
        match (&self.file, &other.file) {
            (Some(left), Some(right)) => Ok(identity(left)? == identity(right)?),
            (None, None) => Ok(true),
            _ => Ok(false),
        }
    }
}

impl FileAccess {
    /// Dispatch only to the OS file manager while the verified handles live.
    /// The callback is not a general permission to reopen this path for I/O.
    pub(crate) fn reveal(
        &self,
        window: &str,
        id: GrantId,
        relative: &Path,
        launch: impl FnOnce(&Path) -> io::Result<()>,
    ) -> Result<(), AccessError> {
        self.reveal_with_hook(window, id, relative, || Ok(()), launch)
    }

    fn reveal_with_hook(
        &self,
        window: &str,
        id: GrantId,
        relative: &Path,
        before_compare: impl FnOnce() -> io::Result<()>,
        launch: impl FnOnce(&Path) -> io::Result<()>,
    ) -> Result<(), AccessError> {
        supported_platform()?;
        let grant = self.get(window, id, Rights::READ)?;
        let (base, suffix, exact) = if let Some(name) = &grant.anchor.file_name {
            if !relative.as_os_str().is_empty() {
                return Err(AccessError::Denied);
            }
            (
                grant
                    .info
                    .selected_path
                    .parent()
                    .ok_or(AccessError::InvalidPath)?,
                Path::new(name),
                true,
            )
        } else {
            if !matches!(grant.info.kind, GrantKind::Workspace | GrantKind::Resource) {
                return Err(AccessError::InvalidKind);
            }
            (grant.info.selected_path.as_path(), relative, false)
        };
        // Authority is the retained handle, never the native display spelling.
        let retained = OpenedTarget::open(grant.anchor.directory.try_clone()?, suffix, exact)?;
        before_compare()?;
        // This ambient walk only verifies that the output locator still names
        // the retained authority. It cannot mint a grant or supply document I/O.
        let mapped = OpenedTarget::open(open_native_directory(base)?, suffix, exact)?;
        if !retained.same_as(&mapped)? {
            return Err(AccessError::Denied);
        }
        let target = if suffix.as_os_str().is_empty() {
            base.to_path_buf()
        } else {
            base.join(suffix)
        };
        launch(&target)?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "file_access_reveal_tests.rs"]
mod tests;
