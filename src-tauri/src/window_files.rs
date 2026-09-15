//! Open-file metadata is never filesystem authority. Caller labels are native.
use crate::native_files;
use std::collections::{BTreeSet, HashMap};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static WINDOW_COUNTER: AtomicU32 = AtomicU32::new(1);

#[derive(Default)]
pub(crate) struct OpenFilesRegistry(Mutex<RegistryEntries>);
#[derive(Default)]
struct RegistryEntries {
    files: HashMap<String, BTreeSet<String>>,
    // Temporary routing is owned by a host transfer nonce, not a caller's normal
    // registration. Rollback cannot erase a concurrent successful open.
    transfers: HashMap<String, (String, String)>,
}
impl OpenFilesRegistry {
    fn register(&self, path: &str, owner: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .files
            .entry(path.into())
            .or_default()
            .insert(owner.into())
    }
    fn remove_file(&self, path: &str, owner: &str) {
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(owners) = entries.files.get_mut(path) {
            owners.remove(owner);
            if owners.is_empty() {
                entries.files.remove(path);
            }
        }
    }
    fn add_transfer(&self, transfer: &native_files::PendingTabTransfer) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .transfers
            .insert(
                transfer.id.clone(),
                (transfer.file_path.clone(), transfer.target_window.clone()),
            );
    }
    fn remove_transfer(&self, id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .transfers
            .remove(id);
    }
    pub(crate) fn remove_window(&self, owner: &str) {
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.files.retain(|_, owners| {
            owners.remove(owner);
            !owners.is_empty()
        });
        entries.transfers.retain(|_, (_, target)| target != owner);
    }
    fn owner(&self, path: &str, caller: &str, live: impl Fn(&str) -> bool) -> Option<String> {
        let entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut owners = entries.files.get(path).cloned().unwrap_or_default();
        for (pending_path, target) in entries.transfers.values() {
            if pending_path == path {
                owners.insert(target.clone());
            }
        }
        drop(entries);
        if owners.contains(caller) && live(caller) {
            return Some(caller.into());
        }
        crate::open_files::document_window_owner(
            owners
                .iter()
                .map(String::as_str)
                .filter(|label| live(label)),
        )
        .map(str::to_owned)
    }
}
#[path = "window_files_ack.rs"]
mod ack;
use ack::{CreatedEditor, TransferWait};
fn require_editor(window: &tauri::Window) -> Result<(), String> {
    if native_files::is_registered(window.app_handle(), window.label()) {
        Ok(())
    } else {
        Err("permission_required".into())
    }
}

// Obsolete renderer windowLabel/sourceWindow arguments are ignored by Tauri.
#[tauri::command]
pub(crate) fn register_open_file(
    window: tauri::Window,
    registry: tauri::State<'_, OpenFilesRegistry>,
    file_path: String,
) -> Result<(), String> {
    require_editor(&window)?;
    registry.register(&file_path, window.label());
    Ok(())
}
#[tauri::command]
pub(crate) fn unregister_open_file(
    window: tauri::Window,
    registry: tauri::State<'_, OpenFilesRegistry>,
    file_path: String,
) -> Result<(), String> {
    require_editor(&window)?;
    registry.remove_file(&file_path, window.label());
    Ok(())
}
#[tauri::command]
pub(crate) fn unregister_window_files(
    window: tauri::Window,
    registry: tauri::State<'_, OpenFilesRegistry>,
) -> Result<(), String> {
    require_editor(&window)?;
    registry.remove_window(window.label());
    Ok(())
}
#[tauri::command]
pub(crate) fn check_file_open(
    window: tauri::Window,
    registry: tauri::State<'_, OpenFilesRegistry>,
    file_path: String,
) -> Result<Option<String>, String> {
    require_editor(&window)?;
    Ok(registry.owner(&file_path, window.label(), |label| {
        native_files::is_registered(window.app_handle(), label)
    }))
}
#[tauri::command]
pub(crate) async fn focus_window_with_file(
    window: tauri::Window,
    file_path: String,
) -> Result<bool, String> {
    require_editor(&window)?;
    let app = window.app_handle();
    let owner = app
        .state::<OpenFilesRegistry>()
        .owner(&file_path, window.label(), |label| {
            native_files::is_registered(app, label)
        });
    if let Some(target) = owner.and_then(|label| app.get_webview_window(&label)) {
        let _ = target.unminimize();
        let _ = target.show();
        target.set_focus().map_err(|e| e.to_string())?;
        target
            .emit("focus-file", file_path)
            .map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub(crate) async fn transfer_tab_to_window(
    window: tauri::Window,
    file_path: String,
    target_window: String,
) -> Result<(), String> {
    require_editor(&window)?;
    let app = window.app_handle();
    let target = app
        .get_webview_window(&target_window)
        .ok_or("permission_required")?;
    // Pending custody and its routing nonce precede the notification. The target
    // reads the durable host queue, and only its successful open ACK completes us.
    let transfer = TransferWait::begin(app, window.label(), &target_window, &file_path)?;
    target
        .emit("tab-transfer", &transfer.payload)
        .map_err(|e| e.to_string())?;
    let _ = target.unminimize();
    let _ = target.show();
    let _ = target.set_focus();
    transfer.wait().await
}

// Mirrors Tauri 2.11.5's private AppManager::get_app_url for this desktop app.
// That helper is crate-private; derive solely from host config, never caller URL.
fn editor_url(
    config: &tauri::utils::config::Config,
    development: bool,
    windows: bool,
) -> Result<tauri::Url, String> {
    let configured = if development {
        config.build.dev_url.clone()
    } else {
        match &config.build.frontend_dist {
            Some(tauri::utils::config::FrontendDist::Url(url)) => Some(url.clone()),
            _ => None,
        }
    };
    let base = configured.unwrap_or(
        tauri::Url::parse(if windows {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        })
        .map_err(|e| e.to_string())?,
    );
    Ok(base)
}

#[tauri::command]
pub(crate) async fn create_new_window(
    window: tauri::Window,
    file_path: Option<String>,
) -> Result<String, String> {
    require_editor(&window)?;
    let app = window.app_handle();
    let id = WINDOW_COUNTER
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            value.checked_add(1)
        })
        .map_err(|_| "window_limit_reached")?;
    let label = format!("window-{id}");
    let destination = editor_url(app.config(), tauri::is_dev(), cfg!(windows))?;
    native_files::reserve_editor(app, &label)?;
    // No application JS runs until registration and capability copy complete.
    let result = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(tauri::Url::parse("about:blank").map_err(|e| e.to_string())?),
    )
    .title("MD Workbench")
    .inner_size(1200.0, 800.0)
    .resizable(true)
    .center()
    .visible(false)
    .build();
    let target = match result {
        Ok(target) => target,
        Err(error) => {
            native_files::cancel_editor_reservation(app, &label);
            return Err(error.to_string());
        }
    };
    let mut created = CreatedEditor::new(target.clone());
    let mut transfer = None;
    let prepare = (|| {
        native_files::activate_editor(app, &label)?;
        if let Some(path) = &file_path {
            transfer = Some(TransferWait::begin(app, window.label(), &label, path)?);
        }
        target.navigate(destination).map_err(|e| e.to_string())?;
        Ok::<_, String>(())
    })();
    // Empty windows do not await an ACK. A file window is opened only from the
    // durable pending queue; no file URL causes a second startup read.
    let prepare = match prepare {
        Ok(()) => match transfer {
            Some(transfer) => transfer.wait().await,
            None => Ok(()),
        },
        Err(error) => Err(error),
    };
    prepare?;
    // An unacknowledged new target must remain hidden: timeout rollback must
    // never destroy unrelated edits the user made while waiting for its open.
    target.show().map_err(|e| e.to_string())?;
    created.commit();
    let _ = target.set_focus();
    crate::notify_pending_open_files(app, None);
    Ok(label)
}

#[cfg(test)]
#[path = "window_files_tests.rs"]
mod tests;
