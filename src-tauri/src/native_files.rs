//! Native authority ingress. Renderer paths can only look up existing grants.
use crate::file_access::{FileAccess, GrantInfo, GrantKind, HeldGrant, Rights};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeGrant {
    id: String,
    path: String,
    kind: &'static str,
    read: bool,
    write: bool,
}
impl From<&GrantInfo> for NativeGrant {
    fn from(info: &GrantInfo) -> Self {
        Self {
            id: info.id.to_string(),
            path: info.selected_path.to_string_lossy().into_owned(),
            kind: match info.kind {
                GrantKind::Document => "document",
                GrantKind::Workspace => "workspace",
                GrantKind::Resource => "resource",
                GrantKind::Export => "export",
            },
            read: info.rights.can_read(),
            write: info.rights.can_write(),
        }
    }
}

#[derive(Default)]
pub(crate) struct NativeFiles(Mutex<NativeState>);
#[derive(Default)]
struct NativeState {
    access: FileAccess,
    windows: HashMap<String, Uuid>,
    building: HashSet<String>,
    transfers: Vec<ack::PendingTransfer>,
    owned: HashMap<(String, String), GrantInfo>,
    // Only OS ingress adds these capabilities; a path lookup cannot populate it.
    pending: HashMap<String, HeldGrant>,
    distributed: HashSet<(String, String)>,
}

#[derive(Clone, Copy)]
enum Purpose {
    Document,
    Save,
    Workspace,
    Resource,
}
impl Purpose {
    fn scope(self) -> (GrantKind, Rights) {
        match self {
            Self::Document => (GrantKind::Document, Rights::READ_WRITE),
            Self::Save => (GrantKind::Export, Rights::WRITE),
            Self::Workspace => (GrantKind::Workspace, Rights::READ_WRITE),
            Self::Resource => (GrantKind::Resource, Rights::READ),
        }
    }
}
impl NativeState {
    fn register(&mut self, label: &str) -> Result<(), String> {
        self.access
            .register_window(label)
            .map_err(|e| e.to_string())?;
        self.windows
            .entry(label.to_owned())
            .or_insert_with(Uuid::new_v4);
        Ok(())
    }
    fn generation(&self, label: &str) -> Result<Uuid, String> {
        self.windows
            .get(label)
            .copied()
            .ok_or_else(|| "permission_required".into())
    }
    fn allows_custom_ipc(&self, webview: &str, window: &str) -> bool {
        webview == window && self.windows.contains_key(window)
    }
    fn revoke(&mut self, label: &str) {
        self.cancel_window_transfers(label);
        self.windows.remove(label);
        self.building.remove(label);
        self.owned.retain(|(owner, _), _| owner != label);
        self.access.revoke_window(label);
        self.distributed.retain(|(owner, _)| owner != label);
        // Pending native ingress owns its original anchor independently.
    }
    fn remember(&mut self, label: &str, requested: &Path, info: GrantInfo) -> NativeGrant {
        let result = NativeGrant::from(&info);
        self.owned.insert(
            (label.to_owned(), requested.to_string_lossy().into_owned()),
            info.clone(),
        );
        self.owned
            .insert((label.to_owned(), result.path.clone()), info);
        result
    }
    fn lookup(&self, label: &str, path: &str) -> Result<Option<NativeGrant>, String> {
        self.generation(label)?;
        Ok(self
            .owned
            .get(&(label.to_owned(), path.to_owned()))
            .map(NativeGrant::from))
    }
    fn select(
        &mut self,
        label: &str,
        generation: Uuid,
        paths: Vec<PathBuf>,
        purpose: Purpose,
    ) -> Result<Vec<NativeGrant>, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let (kind, rights) = purpose.scope();
        let mut selected = Vec::new();
        for path in paths {
            let result = if matches!(purpose, Purpose::Workspace) {
                self.access
                    .grant_directory_from_native_selection(label, &path, kind, rights)
            } else {
                self.access
                    .grant_file_from_native_selection(label, &path, kind, rights)
            };
            match result {
                Ok(info) => selected.push((path, info)),
                Err(error) => {
                    for (_, info) in selected {
                        self.access.revoke(label, info.id);
                    }
                    return Err(error.to_string());
                }
            }
        }
        Ok(selected
            .into_iter()
            .map(|(path, info)| self.remember(label, &path, info))
            .collect())
    }
    fn capture(&mut self, paths: &[String]) -> Vec<NativeError> {
        let mut errors = Vec::new();
        for path in paths {
            if self.pending.contains_key(path) {
                continue;
            }
            match FileAccess::capture_native_file(
                Path::new(path),
                GrantKind::Document,
                Rights::READ_WRITE,
            ) {
                Ok(held) => {
                    self.pending.insert(path.clone(), held);
                }
                Err(error) => errors.push(NativeError {
                    path: path.clone(),
                    error: error.to_string(),
                }),
            }
        }
        errors
    }
    fn distribute(&mut self, label: &str) -> Result<Vec<NativeGrant>, String> {
        self.generation(label)?;
        let mut result = Vec::new();
        for (path, held) in self.pending.clone() {
            if self.distributed.contains(&(label.to_owned(), path.clone())) {
                continue;
            }
            let info = self
                .access
                .attach_native_file(label, &held)
                .map_err(|e| e.to_string())?;
            result.push(self.remember(label, Path::new(&path), info));
            self.distributed.insert((label.to_owned(), path));
        }
        Ok(result)
    }
    fn delivered(&mut self, paths: &[String]) {
        for path in paths {
            self.pending.remove(path);
            self.distributed.retain(|(_, pending)| pending != path);
        }
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct NativeError {
    path: String,
    error: String,
}

pub(crate) fn register_editor(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    app.state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .register(label)
}
pub(crate) fn is_registered(app: &tauri::AppHandle, label: &str) -> bool {
    app.state::<NativeFiles>()
        .0
        .lock()
        .is_ok_and(|state| state.windows.contains_key(label))
}
pub(crate) fn allows_custom_ipc(app: &tauri::AppHandle, webview: &str, window: &str) -> bool {
    app.state::<NativeFiles>()
        .0
        .lock()
        .is_ok_and(|state| state.allows_custom_ipc(webview, window))
}
pub(crate) fn revoke_editor(app: &tauri::AppHandle, label: &str) {
    if let Ok(mut state) = app.state::<NativeFiles>().0.lock() {
        state.revoke(label);
    }
}
pub(crate) fn capture_os_open(app: &tauri::AppHandle, paths: &[String]) -> Vec<NativeError> {
    match app.state::<NativeFiles>().0.lock() {
        Ok(mut state) => state.capture(paths),
        Err(_) => paths
            .iter()
            .map(|path| NativeError {
                path: path.clone(),
                error: "native_state_unavailable".into(),
            })
            .collect(),
    }
}
pub(crate) fn distribute_pending(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    app.state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .distribute(label)?;
    Ok(())
}
pub(crate) fn acknowledge_delivery(app: &tauri::AppHandle, paths: &[String]) {
    if let Ok(mut state) = app.state::<NativeFiles>().0.lock() {
        state.delivered(paths);
    }
}

pub(crate) fn native_drop(app: &tauri::AppHandle, label: &str, paths: &[PathBuf]) {
    let managed = app.state::<NativeFiles>();
    let Ok(mut state) = managed.0.lock() else {
        return;
    };
    let Ok(generation) = state.generation(label) else {
        return;
    };
    let mut grants = Vec::new();
    let mut errors = Vec::new();
    for path in paths {
        let purpose = if path.is_dir() {
            Purpose::Workspace
        } else if crate::open_files::is_supported_markdown_path(path) {
            Purpose::Document
        } else {
            Purpose::Resource
        };
        match state.select(label, generation, vec![path.clone()], purpose) {
            Ok(mut selected) => grants.append(&mut selected),
            Err(error) => errors.push(NativeError {
                path: path.to_string_lossy().into_owned(),
                error,
            }),
        }
    }
    drop(state);
    let _ = app.emit_to(label, "native-file-grants", grants);
    if !errors.is_empty() {
        let _ = app.emit_to(label, "native-file-errors", errors);
    }
}

#[path = "native_files_transfer.rs"]
mod transfer;
pub(crate) use transfer::*;

#[path = "native_files_commands.rs"]
mod commands;
pub(crate) use commands::*;

#[cfg(test)]
#[path = "native_files_tests.rs"]
mod tests;

#[path = "native_files_ack.rs"]
mod ack;
pub(crate) use ack::*;

#[path = "native_files_path.rs"]
mod path;
pub(crate) use path::*;

#[path = "native_files_workspace.rs"]
mod workspace;
pub(crate) use workspace::*;
