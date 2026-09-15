//! Host-only filesystem authority. Never expose grant creation as a Tauri command.
//!
//! Callers must derive window labels from native events / Tauri's injected Window.
//! All I/O stays relative to retained directory handles; no authorized PathBuf is
//! returned for a caller to reopen with ambient std::fs authority.
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

pub(crate) const MAX_IO_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct GrantId(Uuid);

impl GrantId {
    pub(crate) fn parse(value: &str) -> Result<Self, AccessError> {
        Uuid::parse_str(value)
            .map(Self)
            .map_err(|_| AccessError::Denied)
    }
}

impl std::fmt::Display for GrantId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GrantKind {
    Document,
    Workspace,
    Resource,
    Export,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Rights {
    read: bool,
    write: bool,
}

impl Rights {
    pub(crate) const READ: Self = Self {
        read: true,
        write: false,
    };
    pub(crate) const WRITE: Self = Self {
        read: false,
        write: true,
    };
    pub(crate) const READ_WRITE: Self = Self {
        read: true,
        write: true,
    };

    fn contains(self, other: Self) -> bool {
        (!other.read || self.read) && (!other.write || self.write)
    }
}

#[derive(Debug)]
pub(crate) enum AccessError {
    Denied,
    InvalidPath,
    InvalidKind,
    UnsupportedPlatform,
    TooLarge,
    Io(io::Error),
}

impl std::fmt::Display for AccessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Denied => f.write_str("permission_required"),
            Self::InvalidPath => f.write_str("invalid_path"),
            Self::InvalidKind => f.write_str("invalid_grant_kind"),
            Self::UnsupportedPlatform => f.write_str("unsupported_platform"),
            Self::TooLarge => f.write_str("file_too_large"),
            Self::Io(error) => write!(f, "filesystem: {error}"),
        }
    }
}

impl std::error::Error for AccessError {}
impl From<io::Error> for AccessError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct GrantInfo {
    pub(crate) id: GrantId,
    pub(crate) kind: GrantKind,
    pub(crate) rights: Rights,
    /// Display/routing only. Never reopen this path after authorization.
    pub(crate) selected_path: PathBuf,
}

struct Anchor {
    directory: Dir,
    /// Exact-file grants accept only an empty relative path from callers.
    file_name: Option<OsString>,
}

struct Grant {
    info: GrantInfo,
    anchor: Arc<Anchor>,
}

/// Wrap in a host Mutex when managed by Tauri. Hold that lock through each
/// operation so revocation waits for in-flight I/O and no handles escape it.
#[derive(Default)]
pub(crate) struct FileAccess {
    windows: HashSet<String>,
    grants: HashMap<(String, GrantId), Grant>,
}

impl FileAccess {
    /// Call only when the host creates a normal editor window. Print and other
    /// preview labels cannot be registered even by an accidental caller.
    pub(crate) fn register_window(&mut self, window: &str) -> Result<(), AccessError> {
        let editor = window == "main"
            || window.strip_prefix("window-").is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.bytes().all(|b| b.is_ascii_digit())
                    && suffix.parse::<u32>().is_ok_and(|id| id > 0)
            });
        if !editor {
            return Err(AccessError::Denied);
        }
        self.windows.insert(window.to_owned());
        Ok(())
    }

    pub(crate) fn revoke_window(&mut self, window: &str) {
        self.windows.remove(window);
        self.grants.retain(|(owner, _), _| owner != window);
    }

    pub(crate) fn revoke(&mut self, window: &str, id: GrantId) {
        self.grants.remove(&(window.to_owned(), id));
    }

    /// Native dialog/OS-open authority only. Canonicalization chooses the native
    /// selection's anchor; safe handle walking then pins it. This API must never
    /// be called using a recent entry, Markdown reference, tab URL or IPC path.
    pub(crate) fn grant_file_from_native_selection(
        &mut self,
        window: &str,
        path: &Path,
        kind: GrantKind,
        rights: Rights,
    ) -> Result<GrantInfo, AccessError> {
        self.require_window(window)?;
        supported_platform()?;
        if kind == GrantKind::Workspace {
            return Err(AccessError::InvalidKind);
        }
        validate_native_selection(path)?;
        let selected = match std::fs::canonicalize(path) {
            Ok(path) => path,
            Err(error) if error.kind() == io::ErrorKind::NotFound && kind == GrantKind::Export => {
                let parent = path.parent().ok_or(AccessError::InvalidPath)?;
                std::fs::canonicalize(parent)?
                    .join(path.file_name().ok_or(AccessError::InvalidPath)?)
            }
            Err(error) => return Err(error.into()),
        };
        let parent = selected.parent().ok_or(AccessError::InvalidPath)?;
        let name = selected
            .file_name()
            .ok_or(AccessError::InvalidPath)?
            .to_owned();
        validate_relative(Path::new(&name))?;
        let directory = open_native_directory(parent)?;
        // Validate the actual object through the pinned parent, never the earlier
        // path metadata. Export may name a nonexistent file, but not a directory.
        match directory.symlink_metadata(&name) {
            Ok(metadata) if metadata.is_file() => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound && kind == GrantKind::Export => {}
            Ok(_) => return Err(AccessError::InvalidPath),
            Err(error) => return Err(error.into()),
        }
        self.insert(
            window,
            selected,
            kind,
            rights,
            Arc::new(Anchor {
                directory,
                file_name: Some(name),
            }),
        )
    }

    pub(crate) fn grant_directory_from_native_selection(
        &mut self,
        window: &str,
        path: &Path,
        kind: GrantKind,
        rights: Rights,
    ) -> Result<GrantInfo, AccessError> {
        self.require_window(window)?;
        supported_platform()?;
        if !matches!(kind, GrantKind::Workspace | GrantKind::Resource) {
            return Err(AccessError::InvalidKind);
        }
        validate_native_selection(path)?;
        let selected = std::fs::canonicalize(path)?;
        let directory = open_native_directory(&selected)?;
        self.insert(
            window,
            selected,
            kind,
            rights,
            Arc::new(Anchor {
                directory,
                file_name: None,
            }),
        )
    }

    /// Copy only existing rights to an already host-registered editor window.
    /// Source authority remains live until the host closes/acknowledges its tab.
    pub(crate) fn transfer(
        &mut self,
        source: &str,
        target: &str,
        id: GrantId,
        rights: Rights,
    ) -> Result<GrantInfo, AccessError> {
        self.require_window(target)?;
        let grant = self.get(source, id, rights)?;
        let (path, kind, anchor) = (
            grant.info.selected_path.clone(),
            grant.info.kind,
            grant.anchor.clone(),
        );
        self.insert(target, path, kind, rights, anchor)
    }

    pub(crate) fn describe(&self, window: &str, id: GrantId) -> Result<GrantInfo, AccessError> {
        self.require_window(window)?;
        self.grants
            .get(&(window.to_owned(), id))
            .map(|grant| grant.info.clone())
            .ok_or(AccessError::Denied)
    }

    /// Read regular files through pinned handles; limit is enforced before and
    /// during reading. Exact file: relative="". Directory: relative="a/b.md".
    pub(crate) fn read(
        &self,
        window: &str,
        id: GrantId,
        relative: &Path,
        limit: usize,
    ) -> Result<Vec<u8>, AccessError> {
        let grant = self.get(window, id, Rights::READ)?;
        if limit > MAX_IO_BYTES {
            return Err(AccessError::TooLarge);
        }
        let (parent, name) = resolve_parent(&grant.anchor, relative)?;
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No).nonblock(true);
        let file = parent.open_with(name, &options)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(AccessError::InvalidPath);
        }
        if metadata.len() > limit as u64 {
            return Err(AccessError::TooLarge);
        }
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(AccessError::TooLarge);
        }
        Ok(bytes)
    }

    /// Exclusive new-file creation only. There is deliberately no overwrite,
    /// rename or delete API until host CAS/journaling is implemented. On an I/O
    /// failure a partial newly created file may remain; no unsafe path cleanup.
    pub(crate) fn create_new(
        &self,
        window: &str,
        id: GrantId,
        relative: &Path,
        bytes: &[u8],
    ) -> Result<(), AccessError> {
        let grant = self.get(window, id, Rights::WRITE)?;
        if bytes.len() > MAX_IO_BYTES {
            return Err(AccessError::TooLarge);
        }
        let (parent, name) = resolve_parent(&grant.anchor, relative)?;
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut file = parent.open_with(name, &options)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    }

    fn require_window(&self, window: &str) -> Result<(), AccessError> {
        if self.windows.contains(window) {
            Ok(())
        } else {
            Err(AccessError::Denied)
        }
    }

    fn get(&self, window: &str, id: GrantId, rights: Rights) -> Result<&Grant, AccessError> {
        self.require_window(window)?;
        self.grants
            .get(&(window.to_owned(), id))
            .filter(|grant| grant.info.rights.contains(rights))
            .ok_or(AccessError::Denied)
    }

    fn insert(
        &mut self,
        window: &str,
        selected_path: PathBuf,
        kind: GrantKind,
        rights: Rights,
        anchor: Arc<Anchor>,
    ) -> Result<GrantInfo, AccessError> {
        self.require_window(window)?;
        let info = GrantInfo {
            id: GrantId(Uuid::new_v4()),
            kind,
            rights,
            selected_path,
        };
        self.grants.insert(
            (window.to_owned(), info.id),
            Grant {
                info: info.clone(),
                anchor,
            },
        );
        Ok(info)
    }
}

fn supported_platform() -> Result<(), AccessError> {
    if cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )) {
        Ok(())
    } else {
        Err(AccessError::UnsupportedPlatform)
    }
}

fn validate_native_selection(path: &Path) -> Result<(), AccessError> {
    if !path.is_absolute() {
        return Err(AccessError::InvalidPath);
    }
    // Prefixes are accepted only from a trusted native selection, never from
    // relative operation input. Block device namespaces and ADS nonetheless.
    for component in path.components() {
        match component {
            Component::ParentDir => return Err(AccessError::InvalidPath),
            Component::Normal(name) => {
                validate_name(name.to_str().ok_or(AccessError::InvalidPath)?)?
            }
            #[cfg(windows)]
            Component::Prefix(prefix)
                if !matches!(
                    prefix.kind(),
                    std::path::Prefix::Disk(_)
                        | std::path::Prefix::VerbatimDisk(_)
                        | std::path::Prefix::UNC(_, _)
                        | std::path::Prefix::VerbatimUNC(_, _)
                ) =>
            {
                return Err(AccessError::InvalidPath)
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), AccessError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| {
            c.is_control() || matches!(c, ':' | '\\' | '/' | '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return Err(AccessError::InvalidPath);
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|tail| {
                matches!(tail, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        })
    {
        return Err(AccessError::InvalidPath);
    }
    Ok(())
}

fn validate_relative(path: &Path) -> Result<(), AccessError> {
    let raw = path.to_str().ok_or(AccessError::InvalidPath)?;
    // Check the raw string too: Path::components normalizes embedded `.`.
    for name in raw.split('/') {
        validate_name(name)?;
    }
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AccessError::InvalidPath);
    }
    Ok(())
}

/// Resolve each directory component with nofollow before using the final
/// basename. Replacing any path component with a symlink cannot redirect I/O.
fn resolve_parent(anchor: &Anchor, relative: &Path) -> Result<(Dir, OsString), AccessError> {
    supported_platform()?;
    if let Some(name) = &anchor.file_name {
        if !relative.as_os_str().is_empty() {
            return Err(AccessError::Denied);
        }
        return Ok((anchor.directory.try_clone()?, name.clone()));
    }
    validate_relative(relative)?;
    let mut parent = anchor.directory.try_clone()?;
    let mut names = relative.components().peekable();
    while let Some(Component::Normal(name)) = names.next() {
        if names.peek().is_none() {
            return Ok((parent, name.to_owned()));
        }
        parent = parent.open_dir_nofollow(name)?;
    }
    Err(AccessError::InvalidPath)
}

/// Open the selected canonical path from a native filesystem root, refusing
/// symlinks in every subsequent component. cap-std establishes the required
/// Windows directory sharing mode; do not replace it with from_std_file.
fn open_native_directory(path: &Path) -> Result<Dir, AccessError> {
    supported_platform()?;
    let mut root = PathBuf::new();
    let mut names = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => root.push(component.as_os_str()),
            Component::Normal(name) => names.push(name),
            _ => return Err(AccessError::InvalidPath),
        }
    }
    if !root.is_absolute() {
        return Err(AccessError::InvalidPath);
    }
    let mut directory = Dir::open_ambient_dir(root, cap_std::ambient_authority())?;
    for name in names {
        directory = directory.open_dir_nofollow(name)?;
    }
    Ok(directory)
}

#[cfg(test)]
#[path = "file_access_tests.rs"]
mod tests;
