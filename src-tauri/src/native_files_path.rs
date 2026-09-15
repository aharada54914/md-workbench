//! Path strings select existing owned metadata; they never mint capabilities.
use super::*;
use crate::file_access::{DirectoryListing, GrantId};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeDirectoryEntry {
    name: String,
    is_directory: bool,
}
#[derive(Debug, Serialize)]
pub(crate) struct NativeDirectoryListing {
    entries: Vec<NativeDirectoryEntry>,
    omitted: usize,
}
impl From<DirectoryListing> for NativeDirectoryListing {
    fn from(listing: DirectoryListing) -> Self {
        Self {
            entries: listing
                .entries
                .into_iter()
                .map(|entry| NativeDirectoryEntry {
                    name: entry.name,
                    is_directory: entry.is_directory,
                })
                .collect(),
            omitted: listing.omitted,
        }
    }
}
// Only Windows accepts both native separators. This does not resolve dot segments,
// casing, devices, symlinks or disk paths; retained-handle core policy does that.
fn routing_path(path: &str) -> String {
    if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    }
}
fn relative_to(path: &str, root: &str) -> Option<String> {
    let root = root.trim_end_matches('/');
    if path == root {
        return Some(String::new());
    }
    path.strip_prefix(root)?
        .strip_prefix('/')
        .map(str::to_owned)
}
fn has_spelled_prefix(path: &str, root: &str) -> bool {
    let separator = |c| c == '/' || (cfg!(windows) && c == '\\');
    path.strip_prefix(root).is_some_and(|rest| {
        rest.is_empty() || rest.starts_with(separator) || root.ends_with(separator)
    })
}
impl NativeState {
    pub(super) fn resolve_owned_path(
        &self,
        label: &str,
        path: &str,
        directory: bool,
    ) -> Result<(GrantId, String), String> {
        self.generation(label)?;
        if !Path::new(path).is_absolute() {
            return Err("invalid_path".into());
        }
        let routed = routing_path(path);
        let mut owned: Vec<_> = self
            .owned
            .iter()
            .filter(|((owner, _), info)| owner == label && info.rights.can_read())
            .collect();
        // Prefer the precise native alias (or its spelled workspace prefix),
        // then stable spelling order. Equal-length candidates must retain this
        // order instead of choosing a different normalized alias's older handle.
        owned.sort_by(|((_, a), _), ((_, b), _)| {
            (a != path)
                .cmp(&(b != path))
                .then_with(|| (!has_spelled_prefix(path, a)).cmp(&!has_spelled_prefix(path, b)))
                .then_with(|| a.cmp(b))
        });
        if !directory {
            if let Some((_, info)) = owned.iter().find(|((_, alias), info)| {
                info.kind != GrantKind::Workspace && routing_path(alias) == routed
            }) {
                return Ok((info.id, String::new()));
            }
        }
        // NativeState intentionally indexes the latest metadata per alias. A
        // later WRITE-only Save selection can hide an older READ grant. Reject
        // rather than resurrect old IDs or recanonicalize; purpose-specific save
        // lookup must address this before migrating that flow.
        let candidate = owned
            .iter()
            .filter(|(_, info)| info.kind == GrantKind::Workspace)
            .filter_map(|((_, alias), info)| {
                let root = routing_path(alias);
                relative_to(&routed, &root)
                    .map(|relative| (root.trim_end_matches('/').len(), info.id, relative))
            })
            .reduce(|best, next| if next.0 > best.0 { next } else { best });
        candidate
            .map(|(_, id, relative)| (id, relative))
            .ok_or_else(|| "permission_required".into())
    }
    fn read_path(
        &self,
        label: &str,
        generation: Uuid,
        path: &str,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let (id, relative) = self.resolve_owned_path(label, path, false)?;
        self.access
            .read(label, id, Path::new(&relative), limit)
            .map_err(|error| error.to_string())
    }
    fn list_path(
        &self,
        label: &str,
        generation: Uuid,
        path: &str,
        limit: usize,
    ) -> Result<NativeDirectoryListing, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let (id, relative) = self.resolve_owned_path(label, path, true)?;
        self.access
            .list_directory(label, id, Path::new(&relative), limit)
            .map(Into::into)
            .map_err(|error| error.to_string())
    }
}
#[tauri::command]
pub(crate) async fn native_read_path(
    window: tauri::Window,
    path: String,
    limit: usize,
) -> Result<Vec<u8>, NativeCommandError> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let generation = app
        .state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .generation(&label)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeFiles>()
            .0
            .lock()
            .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
            .read_path(&label, generation, &path, limit)
            .map_err(Into::into)
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}
#[tauri::command]
pub(crate) async fn native_list_directory(
    window: tauri::Window,
    path: String,
    limit: usize,
) -> Result<NativeDirectoryListing, NativeCommandError> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let generation = app
        .state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .generation(&label)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeFiles>()
            .0
            .lock()
            .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
            .list_path(&label, generation, &path, limit)
            .map_err(Into::into)
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}
#[cfg(test)]
#[path = "native_files_path_tests.rs"]
mod tests;
