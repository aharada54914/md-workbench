//! Workspace mutations through retained parents. No save, rollback or bulk delete.
use super::*;
use std::ffi::OsStr;

#[cfg(windows)]
#[path = "file_access_rename_windows.rs"]
mod windows;

#[derive(Clone, Copy)]
pub(crate) struct DeleteLimits {
    pub(crate) entries: usize,
    pub(crate) depth: usize,
}
impl Default for DeleteLimits {
    fn default() -> Self {
        Self {
            entries: 10_000,
            depth: 50,
        }
    }
}
#[derive(Debug)]
pub(crate) struct DeleteFailure {
    pub(crate) error: AccessError,
    /// True once a destructive syscall was attempted, even if it returned an
    /// error: some remote filesystems may apply an operation before losing reply.
    pub(crate) partial: bool,
    pub(crate) removed: usize,
}
impl From<AccessError> for DeleteFailure {
    fn from(error: AccessError) -> Self {
        Self {
            error,
            partial: false,
            removed: 0,
        }
    }
}
pub(crate) fn mutation_error_message(error: &AccessError) -> String {
    match error {
        AccessError::Io(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            "already_exists".into()
        }
        AccessError::Io(error) if error.kind() == io::ErrorKind::Unsupported => {
            "unsupported_operation".into()
        }
        _ => error.to_string(),
    }
}
fn unsupported_entry() -> AccessError {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "Special filesystem entry is not supported",
    )
    .into()
}
impl FileAccess {
    fn workspace_parent(
        &self,
        window: &str,
        id: GrantId,
        relative: &Path,
    ) -> Result<(Dir, OsString), AccessError> {
        let grant = self.get(window, id, Rights::WRITE)?;
        if grant.info.kind != GrantKind::Workspace || grant.anchor.file_name.is_some() {
            return Err(AccessError::InvalidKind);
        }
        // Empty relative addresses the selected workspace root, never a child.
        if relative.as_os_str().is_empty() {
            return Err(AccessError::InvalidPath);
        }
        resolve_parent(&grant.anchor, relative)
    }
    pub(crate) fn rename_no_replace(
        &self,
        window: &str,
        source_id: GrantId,
        source: &Path,
        target_id: GrantId,
        target: &Path,
    ) -> Result<(), AccessError> {
        let (source_parent, source_name) = self.workspace_parent(window, source_id, source)?;
        let (target_parent, target_name) = self.workspace_parent(window, target_id, target)?;
        // Authorization and both path validations precede even the no-op.
        if source_id == target_id && source == target {
            return Ok(());
        }
        let kind = source_parent.symlink_metadata(&source_name)?.file_type();
        if !kind.is_file() && !kind.is_dir() && !kind.is_symlink() {
            return Err(unsupported_entry());
        }
        rename_leaf_no_replace(&source_parent, &source_name, &target_parent, &target_name)?;
        Ok(())
    }
    pub(crate) fn delete_tree(
        &self,
        window: &str,
        id: GrantId,
        relative: &Path,
    ) -> Result<(), DeleteFailure> {
        self.delete_tree_with(
            window,
            id,
            relative,
            DeleteLimits::default(),
            &mut |_, _, _| Ok(()),
        )
    }
    fn delete_tree_with(
        &self,
        window: &str,
        id: GrantId,
        relative: &Path,
        limits: DeleteLimits,
        hook: &mut impl FnMut(DeleteStage, &Dir, &OsStr) -> io::Result<()>,
    ) -> Result<(), DeleteFailure> {
        let (parent, name) = self.workspace_parent(window, id, relative)?;
        let mut progress = DeleteProgress {
            limits,
            visited: 0,
            removed: 0,
            attempted: false,
        };
        delete_entry(&parent, &name, 0, &mut progress, hook).map_err(|error| DeleteFailure {
            error,
            partial: progress.attempted,
            removed: progress.removed,
        })
    }
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn rename_leaf_no_replace(
    source: &Dir,
    source_name: &OsStr,
    target: &Dir,
    target_name: &OsStr,
) -> io::Result<()> {
    rustix::fs::renameat_with(
        source,
        source_name,
        target,
        target_name,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(|error| {
        if error == rustix::io::Errno::NOSYS || error == rustix::io::Errno::OPNOTSUPP {
            io::Error::new(io::ErrorKind::Unsupported, error)
        } else {
            error.into()
        }
    })
}
#[cfg(windows)]
fn rename_leaf_no_replace(
    source: &Dir,
    source_name: &OsStr,
    target: &Dir,
    target_name: &OsStr,
) -> io::Result<()> {
    windows::rename_no_replace(source, source_name, target, target_name)
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn rename_leaf_no_replace(_: &Dir, _: &OsStr, _: &Dir, _: &OsStr) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "No no-replace rename primitive",
    ))
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum DeleteStage {
    BeforeInspect,
    AfterOpen,
    BeforeRemove,
}
struct DeleteProgress {
    limits: DeleteLimits,
    visited: usize,
    removed: usize,
    attempted: bool,
}
fn delete_entry(
    parent: &Dir,
    name: &OsStr,
    depth: usize,
    progress: &mut DeleteProgress,
    hook: &mut impl FnMut(DeleteStage, &Dir, &OsStr) -> io::Result<()>,
) -> Result<(), AccessError> {
    if depth > progress.limits.depth || progress.visited >= progress.limits.entries {
        return Err(AccessError::TooLarge);
    }
    progress.visited += 1;
    validate_child_name(name.to_str().ok_or(AccessError::InvalidPath)?)?;
    hook(DeleteStage::BeforeInspect, parent, name)?;
    let metadata = parent.symlink_metadata(name)?;
    let kind = metadata.file_type();
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        // Some reparse types retain ordinary file/directory attributes. Only
        // positively classified symlinks may use the unlink-only branch.
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 && !kind.is_symlink() {
            return Err(unsupported_entry());
        }
    }
    if kind.is_symlink() {
        // Remove the final link itself, never enumerate its target. Windows
        // directory links/junctions require rmdir, which does not recurse.
        hook(DeleteStage::BeforeRemove, parent, name)?;
        progress.attempted = true;
        remove_link(parent, name, kind)?;
    } else if kind.is_dir() {
        let directory = parent.open_dir_nofollow(name)?;
        hook(DeleteStage::AfterOpen, parent, name)?;
        // Keep this directory open throughout enumeration/descent. No filtered
        // UI listing and no bulk remove_dir_all: every encountered entry counts.
        for entry in directory.entries()? {
            let name = entry?.file_name();
            delete_entry(&directory, &name, depth + 1, progress, hook)?;
        }
        // Windows directory handles deny delete sharing. Release this child only,
        // retain its parent and perform one nonrecursive leaf removal.
        drop(directory);
        hook(DeleteStage::BeforeRemove, parent, name)?;
        progress.attempted = true;
        parent.remove_dir(name)?;
    } else if kind.is_file() {
        hook(DeleteStage::BeforeRemove, parent, name)?;
        progress.attempted = true;
        parent.remove_file(name)?;
    } else {
        return Err(unsupported_entry());
    }
    progress.removed += 1;
    Ok(())
}
fn remove_link(parent: &Dir, name: &OsStr, kind: cap_std::fs::FileType) -> io::Result<()> {
    #[cfg(windows)]
    {
        use cap_std::fs::FileTypeExt;
        if kind.is_symlink_dir() {
            return parent.remove_dir(name);
        }
        if !kind.is_symlink_file() {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Unknown reparse entry",
            ));
        }
    }
    #[cfg(not(windows))]
    let _ = kind;
    parent.remove_file(name)
}

#[cfg(test)]
#[path = "file_access_mutation_tests.rs"]
mod tests;
