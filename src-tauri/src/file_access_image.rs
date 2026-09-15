//! Transient, read-only document asset access. Paths here are literal filesystem
//! paths, never Markdown or URLs; no percent-decoding occurs at any stage.
use super::*;

pub(crate) const MAX_DOCUMENT_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_PATH_BYTES: usize = 4096;
const MAX_IMAGE_DEPTH: usize = 50;

fn regular_metadata(metadata: &cap_std::fs::Metadata, directory: bool) -> Result<(), AccessError> {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AccessError::InvalidPath);
        }
    }
    if metadata.file_type().is_symlink()
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err(AccessError::InvalidPath);
    }
    Ok(())
}

fn strict_parent(base: &Dir, relative: &Path) -> Result<(Dir, OsString), AccessError> {
    validate_relative(relative)?;
    let mut parent = base.try_clone()?;
    regular_metadata(&parent.dir_metadata()?, true)?;
    let mut names = relative.components().peekable();
    while let Some(Component::Normal(name)) = names.next() {
        if names.peek().is_none() {
            return Ok((parent, name.to_owned()));
        }
        parent = parent.open_dir_nofollow(name)?;
        regular_metadata(&parent.dir_metadata()?, true)?;
    }
    Err(AccessError::InvalidPath)
}

fn open_regular(parent: &Dir, name: &std::ffi::OsStr) -> Result<cap_std::fs::File, AccessError> {
    // Reject special objects before open, then check the actually opened object
    // too. Nonblocking prevents a swapped FIFO from hanging a reader on Unix.
    regular_metadata(&parent.symlink_metadata(name)?, false)?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    let file = parent.open_with(name, &options)?;
    regular_metadata(&file.metadata()?, false)?;
    Ok(file)
}

impl FileAccess {
    fn image_document_parent(
        &self,
        window: &str,
        id: GrantId,
        document_relative: &Path,
    ) -> Result<(Dir, OsString), AccessError> {
        supported_platform()?;
        let grant = self.get(window, id, Rights::READ)?;
        let (parent, name) = match grant.info.kind {
            GrantKind::Document => {
                if !document_relative.as_os_str().is_empty() {
                    return Err(AccessError::Denied);
                }
                let name = grant
                    .anchor
                    .file_name
                    .as_ref()
                    .ok_or(AccessError::InvalidKind)?;
                strict_parent(&grant.anchor.directory, Path::new(name))?
            }
            GrantKind::Workspace if grant.anchor.file_name.is_none() => {
                strict_parent(&grant.anchor.directory, document_relative)?
            }
            _ => return Err(AccessError::InvalidKind),
        };
        // No document contents are read. Opening verifies the current regular
        // leaf; a grant pins its parent/name, not the original document inode.
        open_regular(&parent, &name)?;
        Ok((parent, name))
    }

    pub(crate) fn validate_image_document(
        &self,
        window: &str,
        id: GrantId,
        document_relative: &Path,
    ) -> Result<(), AccessError> {
        self.image_document_parent(window, id, document_relative)
            .map(|_| ())
    }

    /// Original bytes only, not image decoding or a display-safety guarantee.
    /// The literal relative path must start with images/ or native-stem.assets/.
    pub(crate) fn read_document_image(
        &self,
        window: &str,
        id: GrantId,
        document_relative: &Path,
        image_relative: &Path,
    ) -> Result<Vec<u8>, AccessError> {
        self.read_document_image_with_hooks(
            window,
            id,
            document_relative,
            image_relative,
            || Ok(()),
            || Ok(()),
        )
    }

    fn read_document_image_with_hooks(
        &self,
        window: &str,
        id: GrantId,
        document_relative: &Path,
        image_relative: &Path,
        before_image_open: impl FnOnce() -> io::Result<()>,
        after_image_metadata: impl FnOnce() -> io::Result<()>,
    ) -> Result<Vec<u8>, AccessError> {
        let (parent, document_name) = self.image_document_parent(window, id, document_relative)?;
        let raw = image_relative.to_str().ok_or(AccessError::InvalidPath)?;
        if raw.len() > MAX_IMAGE_PATH_BYTES || raw.split('/').count() > MAX_IMAGE_DEPTH {
            return Err(AccessError::TooLarge);
        }
        validate_relative(image_relative)?;
        let stem = Path::new(&document_name)
            .file_stem()
            .ok_or(AccessError::InvalidPath)?;
        let mut asset_name = stem.to_os_string();
        asset_name.push(".assets");
        let mut components = image_relative.components();
        let first = components.next().ok_or(AccessError::InvalidPath)?;
        if (first.as_os_str() != "images" && first.as_os_str() != asset_name)
            || components.next().is_none()
        {
            return Err(AccessError::Denied);
        }
        before_image_open()?;
        let (image_parent, image_name) = strict_parent(&parent, image_relative)?;
        let file = open_regular(&image_parent, &image_name)?;
        if file.metadata()?.len() > MAX_DOCUMENT_IMAGE_BYTES as u64 {
            return Err(AccessError::TooLarge);
        }
        after_image_metadata()?;
        let mut bytes = Vec::new();
        file.take(MAX_DOCUMENT_IMAGE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_DOCUMENT_IMAGE_BYTES {
            return Err(AccessError::TooLarge);
        }
        Ok(bytes)
    }
}

#[cfg(test)]
#[path = "file_access_image_tests.rs"]
mod tests;
