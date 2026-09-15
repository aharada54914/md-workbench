//! Native-only image selection. A renderer cannot supply paths or filters.
use super::*;

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const MAX_IMAGE_SELECTION: usize = 128;
const MAX_IMAGE_SELECTION_PATH_BYTES: usize = 256 * 1024;

impl NativeState {
    fn select_images(
        &mut self,
        label: &str,
        generation: Uuid,
        paths: Vec<PathBuf>,
    ) -> Result<Vec<NativeGrant>, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        // Validate the entire native result before issuing any capabilities.
        if paths.len() > MAX_IMAGE_SELECTION
            || paths
                .iter()
                .try_fold(0usize, |total, path| {
                    total.checked_add(path.as_os_str().len())
                })
                .is_none_or(|bytes| bytes > MAX_IMAGE_SELECTION_PATH_BYTES)
        {
            return Err("selection_limit_exceeded".into());
        }
        if paths.iter().any(|path| {
            !path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    IMAGE_EXTENSIONS
                        .iter()
                        .any(|allowed| ext.eq_ignore_ascii_case(allowed))
                })
        }) {
            return Err("invalid_path".into());
        }
        self.select(label, generation, paths, Purpose::Resource)
    }
}

#[tauri::command]
pub(crate) async fn native_pick_images(
    window: tauri::Window,
) -> Result<Vec<NativeGrant>, NativeCommandError> {
    let generation = window
        .state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .generation(window.label())?;
    let (sender, receiver) = tokio::sync::oneshot::channel::<Option<Vec<FilePath>>>();
    let dialog = window.dialog().file();
    #[cfg(desktop)]
    let dialog = dialog.set_parent(&window);
    dialog
        .set_title("Choose images")
        .add_filter("Images", IMAGE_EXTENSIONS)
        .pick_files(move |paths| {
            let _ = sender.send(paths);
        });
    let selected = receiver
        .await
        .map_err(|_| "dialog_unavailable")?
        .unwrap_or_default();
    let paths = selected
        .into_iter()
        .map(|path| path.into_path().map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    window
        .state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .select_images(window.label(), generation, paths)
        .map_err(Into::into)
}

#[cfg(test)]
#[path = "native_files_image_picker_tests.rs"]
mod tests;
