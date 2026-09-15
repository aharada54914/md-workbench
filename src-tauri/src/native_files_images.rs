//! Document-derived image byte reads, with no new persistent authority.
use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageDocument {
    grant_id: String,
}

impl NativeState {
    fn image_document(
        &self,
        label: &str,
        generation: Uuid,
        document_path: &str,
    ) -> Result<ImageDocument, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let (id, relative) = self.resolve_owned_path(label, document_path, false)?;
        self.access
            .validate_regular_document(label, id, Path::new(&relative))
            .map_err(|error| error.to_string())?;
        Ok(ImageDocument {
            grant_id: id.to_string(),
        })
    }

    fn read_image(
        &self,
        label: &str,
        generation: Uuid,
        document_path: &str,
        expected_document_grant_id: &str,
        relative_path: &str,
    ) -> Result<Vec<u8>, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let (id, relative) = self.resolve_expected_owned_path(
            label,
            document_path,
            false,
            Some(expected_document_grant_id),
        )?;
        self.access
            .read_document_image(label, id, Path::new(&relative), Path::new(relative_path))
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub(crate) async fn native_resolve_image_document(
    window: tauri::Window,
    document_path: String,
) -> Result<ImageDocument, NativeCommandError> {
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
            .image_document(&label, generation, &document_path)
            .map_err(Into::into)
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}

/// `relative_path` is a literal filesystem-relative path, not a URL. Percent
/// escapes are never decoded. The result is raw bytes, not validated image data.
#[tauri::command]
pub(crate) async fn native_read_document_image(
    window: tauri::Window,
    document_path: String,
    expected_document_grant_id: String,
    relative_path: String,
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
            .read_image(
                &label,
                generation,
                &document_path,
                &expected_document_grant_id,
                &relative_path,
            )
            .map_err(Into::into)
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}

#[cfg(test)]
#[path = "native_files_images_tests.rs"]
mod tests;
