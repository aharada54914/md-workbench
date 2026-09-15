//! Path-compatible workspace mutations; authority stays in the native registry.
use super::*;
use crate::file_access::{mutation_error_message, DeleteFailure};

#[derive(Debug, Serialize)]
pub(crate) struct NativeDeleteError {
    #[serde(flatten)]
    error: NativeCommandError,
    partial: bool,
    removed: usize,
}
impl From<DeleteFailure> for NativeDeleteError {
    fn from(failure: DeleteFailure) -> Self {
        Self {
            error: mutation_error_message(&failure.error).into(),
            partial: failure.partial,
            removed: failure.removed,
        }
    }
}
impl From<String> for NativeDeleteError {
    fn from(error: String) -> Self {
        Self {
            error: error.into(),
            partial: false,
            removed: 0,
        }
    }
}
impl From<&str> for NativeDeleteError {
    fn from(error: &str) -> Self {
        error.to_owned().into()
    }
}
impl NativeState {
    fn rename_workspace_path(
        &self,
        label: &str,
        generation: Uuid,
        from: &str,
        to: &str,
    ) -> Result<(), NativeCommandError> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let (source_id, source) = self.resolve_writable_workspace(label, from)?;
        let (target_id, target) = self.resolve_writable_workspace(label, to)?;
        self.access
            .rename_no_replace(
                label,
                source_id,
                Path::new(&source),
                target_id,
                Path::new(&target),
            )
            .map_err(|error| mutation_error_message(&error).into())
    }
    fn delete_workspace_path(
        &self,
        label: &str,
        generation: Uuid,
        path: &str,
    ) -> Result<(), NativeDeleteError> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let (id, relative) = self.resolve_writable_workspace(label, path)?;
        self.access
            .delete_tree(label, id, Path::new(&relative))
            .map_err(Into::into)
    }
}
#[tauri::command]
pub(crate) async fn rename_path(
    window: tauri::Window,
    from: String,
    to: String,
) -> Result<(), NativeCommandError> {
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
            .rename_workspace_path(&label, generation, &from, &to)
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}
#[tauri::command]
pub(crate) async fn delete_path(
    window: tauri::Window,
    path: String,
) -> Result<(), NativeDeleteError> {
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
            .map_err(|_| NativeDeleteError::from("native_state_unavailable"))?
            .delete_workspace_path(&label, generation, &path)
    })
    .await
    .map_err(|_| NativeDeleteError {
        error: "native_state_unavailable".into(),
        partial: true,
        removed: 0,
    })?
}
#[cfg(test)]
#[path = "native_files_mutation_tests.rs"]
mod tests;
