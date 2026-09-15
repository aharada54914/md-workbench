//! Renderer names only address existing Workspace WRITE authority.
use super::*;
use crate::file_access::validate_child_name;

impl NativeState {
    fn create_workspace_child(
        &self,
        label: &str,
        generation: Uuid,
        parent: &str,
        name: &str,
        directory: bool,
    ) -> Result<String, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let (id, relative_parent) = self.resolve_writable_workspace(label, parent)?;
        let trimmed = name.trim();
        validate_child_name(trimmed).map_err(|error| error.to_string())?;
        let name = if directory || crate::is_workspace_markdown(trimmed) {
            trimmed.to_owned()
        } else {
            format!("{trimmed}.md")
        };
        // Do not use Path::join here: on Windows the core intentionally takes
        // clean '/' relative paths and rejects renderer-spelled backslashes.
        let relative = if relative_parent.is_empty() {
            name.clone()
        } else {
            format!("{relative_parent}/{name}")
        };
        if directory {
            self.access
                .create_directory(label, id, Path::new(&relative))
        } else {
            self.access.create_new(label, id, Path::new(&relative), b"")
        }
        .map_err(|error| error.to_string())?;
        // Display/reference only; this path is never reopened with ambient I/O.
        Ok(Path::new(parent).join(name).to_string_lossy().into_owned())
    }
}
async fn create_child(
    window: tauri::Window,
    parent: String,
    name: String,
    directory: bool,
) -> Result<String, NativeCommandError> {
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
            .create_workspace_child(&label, generation, &parent, &name, directory)
            .map_err(Into::into)
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}
#[tauri::command]
pub(crate) async fn create_md_file(
    window: tauri::Window,
    parent: String,
    name: String,
) -> Result<String, NativeCommandError> {
    create_child(window, parent, name, false).await
}
#[tauri::command]
pub(crate) async fn create_folder(
    window: tauri::Window,
    parent: String,
    name: String,
) -> Result<String, NativeCommandError> {
    create_child(window, parent, name, true).await
}
#[cfg(test)]
#[path = "native_files_create_tests.rs"]
mod tests;
