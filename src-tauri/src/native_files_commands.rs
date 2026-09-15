use super::*;
use crate::file_access::GrantId;

/// Stable IPC code plus diagnostic message; callers must branch on code.
#[derive(Debug, Serialize)]
pub(crate) struct NativeCommandError {
    code: &'static str,
    message: String,
}
impl From<String> for NativeCommandError {
    fn from(message: String) -> Self {
        let code = match message.as_str() {
            "permission_required" => "permission_required",
            "invalid_path" => "invalid_path",
            "invalid_grant_kind" => "invalid_grant_kind",
            "unsupported_platform" => "unsupported_platform",
            "file_too_large" => "file_too_large",
            "file_not_found" => "file_not_found",
            "watch_busy" => "watch_busy",
            "watch_limit_exceeded" => "watch_limit_exceeded",
            "selection_limit_exceeded" => "selection_limit_exceeded",
            "already_exists" => "already_exists",
            "unsupported_operation" => "unsupported_operation",
            "native_state_unavailable" => "native_state_unavailable",
            "dialog_unavailable" => "dialog_unavailable",
            _ => "filesystem_error",
        };
        Self { code, message }
    }
}
impl From<&str> for NativeCommandError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

#[tauri::command]
pub(crate) async fn native_read_grant(
    window: tauri::Window,
    id: String,
    relative: String,
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
        let managed = app.state::<NativeFiles>();
        let state = managed.0.lock().map_err(|_| "native_state_unavailable")?;
        if state.generation(&label)? != generation {
            return Err(NativeCommandError::from("permission_required"));
        }
        let id = GrantId::parse(&id).map_err(|e| e.to_string())?;
        state
            .access
            .read(&label, id, Path::new(&relative), limit)
            .map_err(|e| NativeCommandError::from(e.to_string()))
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}

#[tauri::command]
pub(crate) fn native_get_grant(
    window: tauri::Window,
    path: String,
) -> Result<Option<NativeGrant>, NativeCommandError> {
    window
        .state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .lookup(window.label(), &path)
        .map_err(Into::into)
}

async fn pick(
    window: tauri::Window,
    purpose: Purpose,
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
    match purpose {
        Purpose::Document => dialog
            .set_title("Open documents")
            .add_filter("Markdown", &["md", "markdown"])
            .pick_files(move |paths| {
                let _ = sender.send(paths);
            }),
        Purpose::Save => dialog
            .set_title("Choose save destination")
            .save_file(move |path| {
                let _ = sender.send(path.map(|path| vec![path]));
            }),
        Purpose::Workspace => dialog.set_title("Open workspace").pick_folder(move |path| {
            let _ = sender.send(path.map(|path| vec![path]));
        }),
        Purpose::Resource => dialog.set_title("Read resource").pick_file(move |path| {
            let _ = sender.send(path.map(|path| vec![path]));
        }),
    }
    let selected = receiver.await.map_err(|_| "dialog_unavailable")?;
    let Some(selected) = selected else {
        return Ok(Vec::new());
    };
    let paths = selected
        .into_iter()
        .map(|path| path.into_path().map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    window
        .state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .select(window.label(), generation, paths, purpose)
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn native_pick_documents(
    window: tauri::Window,
) -> Result<Vec<NativeGrant>, NativeCommandError> {
    pick(window, Purpose::Document).await
}
#[tauri::command]
pub(crate) async fn native_pick_save_destination(
    window: tauri::Window,
) -> Result<Option<NativeGrant>, NativeCommandError> {
    Ok(pick(window, Purpose::Save).await?.into_iter().next())
}
#[tauri::command]
pub(crate) async fn native_pick_workspace(
    window: tauri::Window,
) -> Result<Option<NativeGrant>, NativeCommandError> {
    Ok(pick(window, Purpose::Workspace).await?.into_iter().next())
}
#[tauri::command]
pub(crate) async fn native_pick_resource(
    window: tauri::Window,
) -> Result<Option<NativeGrant>, NativeCommandError> {
    Ok(pick(window, Purpose::Resource).await?.into_iter().next())
}
