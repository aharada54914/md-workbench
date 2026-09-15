//! Bounded direct-child listing through an owned directory handle.
use super::*;

pub(crate) const MAX_DIRECTORY_ENTRIES: usize = 10_000;

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct DirectoryEntry {
    pub(crate) name: String,
    pub(crate) is_directory: bool,
    pub(crate) modified: u64,
}

#[derive(Debug)]
pub(crate) struct DirectoryListing {
    pub(crate) entries: Vec<DirectoryEntry>,
    /// Nonportable names, links and special files cannot be safely opened by
    /// the broker. Surface the omission count instead of hiding incomplete data.
    pub(crate) omitted: usize,
    pub(crate) modified: u64,
}

fn modified_millis(metadata: &cap_std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

impl FileAccess {
    /// Empty relative path lists the selected directory itself. Every later
    /// read/list must still authorize and open its path anew; these rows are
    /// routing metadata and may become stale after enumeration.
    pub(crate) fn list_directory(
        &self,
        window: &str,
        id: GrantId,
        relative: &Path,
        limit: usize,
    ) -> Result<DirectoryListing, AccessError> {
        let grant = self.get(window, id, Rights::READ)?;
        if grant.anchor.file_name.is_some()
            || !matches!(grant.info.kind, GrantKind::Workspace | GrantKind::Resource)
        {
            return Err(AccessError::InvalidKind);
        }
        supported_platform()?;
        if limit > MAX_DIRECTORY_ENTRIES {
            return Err(AccessError::TooLarge);
        }
        let mut directory = grant.anchor.directory.try_clone()?;
        if !relative.as_os_str().is_empty() {
            validate_relative(relative)?;
            for component in relative.components() {
                let Component::Normal(name) = component else {
                    return Err(AccessError::InvalidPath);
                };
                directory = directory.open_dir_nofollow(name)?;
            }
        }
        let mut listing = DirectoryListing {
            entries: Vec::new(),
            omitted: 0,
            modified: modified_millis(&directory.dir_metadata()?),
        };
        for (index, entry) in directory.entries()?.enumerate() {
            // Count every scanned entry, including ones excluded below. Never
            // turn the requested bound into unbounded scanning of invalid names.
            if index >= limit {
                return Err(AccessError::TooLarge);
            }
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name
                .to_str()
                .filter(|name| validate_relative(Path::new(name)).is_ok())
            else {
                listing.omitted += 1;
                continue;
            };
            // DirEntry metadata is nofollow and anchored to this enumeration.
            // Use the same snapshot for type and mtime; absolute paths are never
            // reopened and symlink target metadata is never requested.
            let metadata = entry.metadata()?;
            let kind = metadata.file_type();
            if kind.is_symlink() || (!kind.is_file() && !kind.is_dir()) {
                listing.omitted += 1;
                continue;
            }
            listing.entries.push(DirectoryEntry {
                name: name.into(),
                is_directory: kind.is_dir(),
                modified: modified_millis(&metadata),
            });
        }
        listing.entries.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(listing)
    }
}

#[cfg(test)]
#[path = "file_access_directory_tests.rs"]
mod tests;
