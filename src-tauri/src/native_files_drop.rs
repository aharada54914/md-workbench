//! Host OS drops wait for a renderer listener without trusting renderer paths.
use super::*;
use crate::file_access::GrantId;

const MAX_PENDING_DROPS: usize = 16;
const MAX_DROP_PATHS: usize = 128;
const MAX_DROP_PATH_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct DropPosition {
    x: f64,
    y: f64,
}
#[derive(Clone, Debug, Serialize)]
pub(crate) struct NativeDrop {
    id: String,
    grants: Vec<NativeGrant>,
    errors: Vec<NativeError>,
    position: DropPosition,
}
pub(super) struct QueuedDrop {
    generation: Uuid,
    id: String,
    items: Vec<Result<NativeGrant, NativeError>>,
    position: DropPosition,
}
fn is_drop_document(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "txt" | "mermark"
            )
        })
}
impl NativeState {
    fn enqueue_drop(
        &mut self,
        label: &str,
        generation: Uuid,
        paths: &[PathBuf],
        position: DropPosition,
    ) -> Result<bool, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        if paths.is_empty() {
            return Ok(false);
        }
        // Reject before classification/grant creation so existing metadata and
        // queued operations cannot change when native input exceeds the bounds.
        if self
            .drops
            .get(label)
            .is_some_and(|queue| queue.len() >= MAX_PENDING_DROPS)
        {
            return Err("drop_queue_full".into());
        }
        let bytes = paths.iter().try_fold(0usize, |total, path| {
            total.checked_add(path.to_string_lossy().len())
        });
        if paths.len() > MAX_DROP_PATHS || bytes.is_none_or(|n| n > MAX_DROP_PATH_BYTES) {
            return Err("drop_too_large".into());
        }
        let mut items = Vec::with_capacity(paths.len());
        for path in paths {
            // Only the host's OS Drop event reaches this classification; it is
            // not an IPC that can stat arbitrary renderer-supplied paths.
            let purpose = if path.is_dir() {
                Purpose::Workspace
            } else if is_drop_document(path) {
                Purpose::Document
            } else {
                Purpose::Resource
            };
            match self.select(label, generation, vec![path.clone()], purpose) {
                Ok(grants) => items.extend(grants.into_iter().map(Ok)),
                Err(error) => items.push(Err(NativeError {
                    path: path.to_string_lossy().into_owned(),
                    error,
                })),
            }
        }
        self.drops
            .entry(label.into())
            .or_default()
            .push(QueuedDrop {
                generation,
                id: Uuid::new_v4().to_string(),
                items,
                position,
            });
        Ok(true)
    }
    fn drop_grant_is_current(&self, label: &str, grant: &NativeGrant) -> bool {
        let Ok(id) = GrantId::parse(&grant.id) else {
            return false;
        };
        self.owned
            .get(&(label.into(), grant.path.clone()))
            .is_some_and(|info| info.id == id)
            && self.access.describe(label, id).is_ok()
            && self
                .resolve_owned_path(label, &grant.path, grant.kind == "workspace")
                .is_ok_and(|(current, relative)| current == id && relative.is_empty())
    }
    fn take_drops(&mut self, label: &str, generation: Uuid) -> Result<Vec<NativeDrop>, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let pending = self.drops.remove(label).unwrap_or_default();
        Ok(pending
            .into_iter()
            .filter(|drop| drop.generation == generation)
            .map(|drop| {
                let mut grants = Vec::new();
                let mut errors = Vec::new();
                for item in drop.items {
                    match item {
                        Ok(grant) if self.drop_grant_is_current(label, &grant) => {
                            grants.push(grant)
                        }
                        Ok(grant) => errors.push(NativeError {
                            path: grant.path,
                            error: "drop_grant_changed".into(),
                        }),
                        Err(error) => errors.push(error),
                    }
                }
                NativeDrop {
                    id: drop.id,
                    grants,
                    errors,
                    position: drop.position,
                }
            })
            .collect())
    }
}

pub(crate) fn native_drop(
    app: &tauri::AppHandle,
    label: &str,
    paths: &[PathBuf],
    position: tauri::PhysicalPosition<f64>,
) {
    let managed = app.state::<NativeFiles>();
    let result = (|| {
        let mut state = managed.0.lock().map_err(|_| "native_state_unavailable")?;
        let generation = state.generation(label)?;
        state.enqueue_drop(
            label,
            generation,
            paths,
            DropPosition {
                x: position.x,
                y: position.y,
            },
        )
    })();
    match result {
        Ok(true) => {
            let _ = app.emit_to(label, "native-drops-pending", ());
        }
        Ok(false) => {}
        Err(error) => {
            // One bounded error, not a second event for ordinary partial drops.
            let _ = app.emit_to(
                label,
                "native-file-errors",
                vec![NativeError {
                    path: String::new(),
                    error,
                }],
            );
        }
    }
}

#[tauri::command]
pub(crate) fn native_take_drops(window: tauri::Window) -> Result<Vec<NativeDrop>, String> {
    let managed = window.state::<NativeFiles>();
    let mut state = managed.0.lock().map_err(|_| "native_state_unavailable")?;
    let generation = state.generation(window.label())?;
    state.take_drops(window.label(), generation)
}

#[cfg(test)]
#[path = "native_files_drop_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "native_files_drop_read_tests.rs"]
mod read_tests;
