#[cfg(feature = "diagram-isolation-spike")]
mod diagram_spike;
use std::sync::Mutex;
use std::collections::BTreeSet;
use std::path::Path;
use tauri::{Manager, Emitter, WebviewUrl, WebviewWindowBuilder, RunEvent, WindowEvent};
use font_kit::source::SystemSource;

mod ai;
mod file_access;
mod native_files;
mod open_files;
mod resources;
mod window_files;
use window_files::*;

use open_files::{OpenFileState, paths_from_args, document_window_owner};

// Serialize queue mutation with retained native authority acknowledgement.
static NATIVE_OPEN_DELIVERY_LOCK: Mutex<()> = Mutex::new(());

fn native_open_owner(app: &tauri::AppHandle, closing_label: Option<&str>) -> Option<tauri::WebviewWindow> {
    let windows = app.webview_windows();
    let label = document_window_owner(windows.keys().map(String::as_str)
        .filter(|label| Some(*label) != closing_label && native_files::is_registered(app, label)))?;
    windows.get(label).cloned()
}

fn is_native_open_owner(window: &tauri::Window) -> bool {
    native_open_owner(window.app_handle(), None)
        .is_some_and(|owner| owner.label() == window.label())
}

#[tauri::command]
fn get_open_file_path(window: tauri::Window, state: tauri::State<'_, OpenFileState>) -> Option<String> {
    let _delivery = NATIVE_OPEN_DELIVERY_LOCK.lock().ok()?;
    if !is_native_open_owner(&window)
        || native_files::distribute_pending(window.app_handle(), window.label()).is_err() {
        return None;
    }
    let path = state.pop();
    if let Some(path) = &path {
        native_files::acknowledge_delivery(window.app_handle(), std::slice::from_ref(path));
    }
    path
}

#[tauri::command]
fn get_open_file_paths(window: tauri::Window, state: tauri::State<'_, OpenFileState>) -> Vec<String> {
    let Ok(_delivery) = NATIVE_OPEN_DELIVERY_LOCK.lock() else { return Vec::new(); };
    // One live document window owns delivery. Print/preview webviews never do.
    if !is_native_open_owner(&window)
        || native_files::distribute_pending(window.app_handle(), window.label()).is_err() {
        return Vec::new();
    }
    let paths = state.drain();
    native_files::acknowledge_delivery(window.app_handle(), &paths);
    paths
}

fn notify_pending_open_files(app: &tauri::AppHandle, closing_label: Option<&str>) {
    if !app.state::<OpenFileState>().has_pending() {
        return;
    }
    if let Some(window) = native_open_owner(app, closing_label) {
        if native_files::distribute_pending(app, window.label()).is_err() { return; }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("open-files-pending", ());
    }
}

fn queue_open_files(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let Ok(delivery) = NATIVE_OPEN_DELIVERY_LOCK.lock() else { return; };
    let errors = native_files::capture_os_open(app, &paths);
    app.state::<OpenFileState>().enqueue(paths);
    if !errors.is_empty() {
        if let Some(window) = native_open_owner(app, None) {
            let _ = window.emit("native-file-errors", errors);
        }
    }
    drop(delivery);
    // If no consumer is ready, its startup getter will drain the retained queue.
    notify_pending_open_files(app, None);
}

// Dedicated window that renders the print-ready document for native printing.
const PRINT_WINDOW_LABEL: &str = "print-preview";
// Custom URI scheme that serves the print-ready HTML from memory.
const PRINT_SCHEME: &str = "mermarkprint";

// Holds the print-ready HTML served to the print window by the custom protocol.
pub struct PrintHtmlState(pub Mutex<Option<String>>);

#[tauri::command]
fn get_all_windows(app: tauri::AppHandle) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter(|label| native_files::is_registered(&app, label))
        .cloned()
        .collect()
}

/// Render the print-ready HTML in a dedicated webview window and fire the native
/// print dialog on it. WKWebView (macOS) ignores `print()` on iframes, so the
/// in-app preview iframe could never print there (#103).
///
/// The window loads its content from the in-memory `mermarkprint://` protocol
/// rather than `file://` (which WKWebView refuses via `loadRequest:`) or post-
/// load JS injection (which rendered blank). `async` keeps window creation off
/// the main thread, since creating a webview from a sync command can deadlock.
#[tauri::command]
async fn print_document(app: tauri::AppHandle, html: String) -> Result<(), String> {
    *app.state::<PrintHtmlState>().0.lock().unwrap() = Some(html);

    if let Some(existing) = app.get_webview_window(PRINT_WINDOW_LABEL) {
        let _ = existing.close();
    }

    // Custom schemes resolve to `scheme://localhost` on macOS/Linux but
    // `http://scheme.localhost` on Windows/Android.
    let url = if cfg!(any(windows, target_os = "android")) {
        format!("http://{PRINT_SCHEME}.localhost/")
    } else {
        format!("{PRINT_SCHEME}://localhost/")
    };
    let url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;

    WebviewWindowBuilder::new(&app, PRINT_WINDOW_LABEL, WebviewUrl::CustomProtocol(url))
        .title("MD Workbench — Print / PDF")
        .inner_size(900.0, 1100.0)
        .center()
        .initialization_script("window.addEventListener('afterprint',function(){window.close();});")
        // on_page_load runs on the UI thread — which WKWebView's print() requires —
        // and firing on Finished prints exactly when the document is ready.
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = window.print();
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn get_current_window_label(window: tauri::Window) -> String {
    window.label().to_string()
}

// ============== AI commands (storage + health) ==============

use ai::types::{AccessMap, AuditEntry, CliKind, HealthStatus, SessionMapping, SnapshotIndexEntry};

#[tauri::command]
async fn ai_health_check(cli: CliKind, override_path: Option<String>) -> HealthStatus {
    ai::health::check(cli, override_path.as_deref()).await
}

#[tauri::command]
async fn ai_ollama_models(base_url: Option<String>) -> Result<Vec<String>, String> {
    ai::process::ollama::list_models(base_url.as_deref()).await
}

#[tauri::command]
async fn ai_openai_models(base_url: Option<String>) -> Result<Vec<String>, String> {
    ai::process::openai::list_models(base_url.as_deref()).await
}

#[tauri::command]
async fn ai_codex_models() -> Vec<ai::process::codex::CodexModelOption> {
    ai::process::codex::list_models().await
}

#[tauri::command]
fn ai_access_load(app: tauri::AppHandle, doc_path: String) -> Result<AccessMap, String> {
    ai::access_map::load(&app, &doc_path)
}

#[tauri::command]
fn ai_access_save(app: tauri::AppHandle, doc_path: String, map: AccessMap) -> Result<(), String> {
    ai::access_map::save(&app, &doc_path, &map)
}

#[tauri::command]
fn ai_access_migrate(app: tauri::AppHandle, old_path: String, new_path: String) -> Result<(), String> {
    ai::access_map::migrate(&app, &old_path, &new_path)
}

#[tauri::command]
fn ai_session_get(app: tauri::AppHandle, doc_path: String) -> Result<Option<SessionMapping>, String> {
    ai::sessions::get(&app, &doc_path)
}

#[tauri::command]
fn ai_session_upsert(app: tauri::AppHandle, mapping: SessionMapping) -> Result<(), String> {
    ai::sessions::upsert(&app, mapping)
}

#[tauri::command]
fn ai_session_remove(app: tauri::AppHandle, doc_path: String) -> Result<(), String> {
    ai::sessions::remove(&app, &doc_path)
}

#[tauri::command]
fn ai_session_migrate(app: tauri::AppHandle, old_path: String, new_path: String) -> Result<(), String> {
    ai::sessions::migrate(&app, &old_path, &new_path)
}

#[tauri::command]
fn ai_session_recover_by_hash(app: tauri::AppHandle, content_hash: String, cli: CliKind) -> Result<Option<SessionMapping>, String> {
    ai::sessions::recover_by_hash(&app, &content_hash, cli)
}

#[tauri::command]
fn ai_snapshot_list(app: tauri::AppHandle, doc_path: String) -> Result<Vec<SnapshotIndexEntry>, String> {
    ai::snapshots::list(&app, &doc_path)
}

#[tauri::command]
fn ai_snapshot_create(app: tauri::AppHandle, doc_path: String, content: String, source_session_id: Option<String>, keep: usize) -> Result<SnapshotIndexEntry, String> {
    ai::snapshots::create(&app, &doc_path, &content, source_session_id, keep)
}

#[tauri::command]
fn ai_snapshot_restore(app: tauri::AppHandle, doc_path: String, id: String) -> Result<String, String> {
    ai::snapshots::restore(&app, &doc_path, &id)
}

#[tauri::command]
fn ai_snapshot_set_pinned(app: tauri::AppHandle, doc_path: String, id: String, pinned: bool) -> Result<(), String> {
    ai::snapshots::set_pinned(&app, &doc_path, &id, pinned)
}

#[tauri::command]
fn ai_snapshot_delete(app: tauri::AppHandle, doc_path: String, id: String) -> Result<(), String> {
    ai::snapshots::delete(&app, &doc_path, &id)
}

#[tauri::command]
fn ai_snapshot_export(app: tauri::AppHandle, doc_path: String, id: String, dest: String) -> Result<(), String> {
    ai::snapshots::export(&app, &doc_path, &id, std::path::Path::new(&dest))
}

#[tauri::command]
fn ai_snapshot_migrate(app: tauri::AppHandle, old_path: String, new_path: String) -> Result<(), String> {
    ai::snapshots::migrate(&app, &old_path, &new_path)
}

#[tauri::command]
fn ai_audit_append(app: tauri::AppHandle, entry: AuditEntry) -> Result<(), String> {
    ai::audit::append(&app, entry)
}

#[tauri::command]
fn ai_audit_read(app: tauri::AppHandle, since: Option<String>, until: Option<String>) -> Result<Vec<AuditEntry>, String> {
    ai::audit::read(&app, since.as_deref(), until.as_deref())
}

#[tauri::command]
fn ai_audit_clear(app: tauri::AppHandle) -> Result<(), String> {
    ai::audit::clear(&app)
}

#[tauri::command]
async fn ai_send(
    app: tauri::AppHandle,
    window: tauri::Window,
    registry: tauri::State<'_, ai::process::ChildRegistry>,
    req: ai::process::AiSendRequest,
    request_id: String,
) -> Result<String, String> {
    ai::process::spawn(app, window.label().to_string(), registry, req, request_id).await
}

#[tauri::command]
fn ai_cancel(
    app: tauri::AppHandle,
    window: tauri::Window,
    registry: tauri::State<'_, ai::process::ChildRegistry>,
    request_id: String,
) {
    ai::process::cancel(&app, window.label(), &registry, &request_id);
}

/// Persist an image (clipboard paste, drag-drop, etc.) to a temporary file
/// inside `<app_data>/ai/images/` and return its absolute path. The frontend
/// then references that path via `convertFileSrc` for previews and forwards
/// it through `AiSendRequest.images` so the backend can attach it to claude
/// or codex.
#[tauri::command]
fn ai_image_save(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    extension: String,
) -> Result<String, String> {
    let dir = ai::paths::images_dir(&app)?;
    let safe_ext = extension.trim().trim_start_matches('.').to_ascii_lowercase();
    let allowed = matches!(safe_ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp");
    let ext = if allowed { safe_ext.as_str() } else { "png" };
    let name = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let path = dir.join(name);
    std::fs::write(&path, &bytes).map_err(|e| format!("write image failed: {}", e))?;
    Ok(path.to_string_lossy().into_owned())
}

// ============== Workspace (folder browser) commands ==============

fn is_workspace_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx")
}

fn is_workspace_hidden(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

/// `Some(open target)` when `path` is a filesystem root — a drive (`C:`) or a UNC
/// share (`\\server\share`). A root cannot be selected inside a parent, and
/// `/select,` on one drops explorer at "This PC", so roots get opened directly.
#[cfg(any(test, target_os = "windows"))]
fn windows_reveal_root(path: &str) -> Option<String> {
    if let Some(rest) = path.strip_prefix(r"\\") {
        let mut parts = rest.split('\\').filter(|s| !s.is_empty());
        let server = parts.next()?;
        let share = parts.next();
        if parts.next().is_some() {
            return None;
        }
        return Some(match share {
            Some(share) => format!(r"\\{}\{}", server, share),
            None => format!(r"\\{}", server),
        });
    }

    let bytes = path.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Some(format!("{}\\", path));
    }
    None
}

/// Build the raw `explorer.exe` command line for revealing `path` (#125).
///
/// This has to bypass `Command::arg`: std wraps any argument containing a space
/// in quotes, and explorer parses the resulting `"/select,C:\a b\c.md"` as a path
/// rather than a switch, then silently falls back to the user's Documents folder.
/// Explorer also only understands backslashes — a `C:/…` path lands it on "This PC".
#[cfg(any(test, target_os = "windows"))]
fn windows_reveal_arg(path: &str) -> String {
    let normalized = path.replace('/', "\\");
    let target = normalized.trim_end_matches('\\');
    match windows_reveal_root(target) {
        Some(root) => format!("\"{}\"", root),
        None => format!("/select,\"{}\"", target),
    }
}

/// List all font family names installed on the system.
/// Returns a sorted, deduplicated list of font family names.
#[tauri::command]
fn list_system_fonts() -> Vec<String> {
    let source = SystemSource::new();
    let mut families = BTreeSet::new();

    if let Ok(all_fonts) = source.all_families() {
        for family in all_fonts {
            // Skip hidden/internal fonts (starting with . or #)
            if !family.starts_with('.') && !family.starts_with('#') {
                families.insert(family);
            }
        }
    }

    families.into_iter().collect()
}

#[cfg(any(test, target_os = "linux"))]
#[derive(Clone, Copy)]
struct StartupEnvOverride {
    key: &'static str,
    value: &'static str,
}

// Helps with rendering glitches on fragile GPU stacks (NVIDIA, VMs) where EGL
// itself works. NOTE: these vars cannot prevent the `Could not create default
// EGL display: EGL_BAD_PARAMETER` abort from #106 — since WebKitGTK 2.46 the
// WebProcess initializes its EGL display before the preference store is applied
// (WebPage.cpp: drawingArea->updatePreferences runs ahead of updatePreferences),
// so the abort is reachable regardless. The actual #106 fix is in release.yml:
// the AppImage must not bundle libwayland-client.so.0.
#[cfg(any(test, target_os = "linux"))]
const LINUX_WEBKIT_RENDER_OVERRIDES: [StartupEnvOverride; 2] = [
    StartupEnvOverride { key: "WEBKIT_DISABLE_DMABUF_RENDERER", value: "1" },
    StartupEnvOverride { key: "WEBKIT_DISABLE_COMPOSITING_MODE", value: "1" },
];

// Inject an override only when the user has not already set a meaningful value,
// so an explicit `WEBKIT_DISABLE_*` from the environment stays authoritative.
#[cfg(any(test, target_os = "linux"))]
fn should_apply_webkit_override(current: Option<&std::ffi::OsStr>) -> bool {
    match current {
        Some(value) => value.to_string_lossy().trim().is_empty(),
        None => true,
    }
}

// Must run before the first webview spawns and while still single-threaded
// (top of `run`), since `set_var` is only sound before other threads read env.
#[cfg(any(test, target_os = "linux"))]
fn apply_linux_webkit_overrides() {
    for ov in LINUX_WEBKIT_RENDER_OVERRIDES {
        if should_apply_webkit_override(std::env::var_os(ov.key).as_deref()) {
            std::env::set_var(ov.key, ov.value);
        }
    }
}

// The AppImage AppRun hook shipped by linuxdeploy-plugin-gtk used to pin
// `GDK_BACKEND=x11`, so a GNOME/Wayland session got XWayland and its resize bugs
// (#126). release.yml now strips that line, and the preference is pinned here so
// it no longer depends on the compiled-in backend order of whichever GTK build a
// distro package links against. `wayland,x11` keeps the X11 fallback for
// sessions where the Wayland backend cannot connect.
#[cfg(any(test, target_os = "linux"))]
const LINUX_WAYLAND_GDK_BACKEND: &str = "wayland,x11";

#[cfg(any(test, target_os = "linux"))]
fn wayland_gdk_backend(
    gdk_backend: Option<&std::ffi::OsStr>,
    wayland_display: Option<&std::ffi::OsStr>,
    session_type: Option<&std::ffi::OsStr>,
) -> Option<&'static str> {
    let user_pinned_backend = gdk_backend
        .map(|v| !v.to_string_lossy().trim().is_empty())
        .unwrap_or(false);
    if user_pinned_backend {
        return None;
    }
    let has_wayland_socket = wayland_display
        .map(|v| !v.to_string_lossy().trim().is_empty())
        .unwrap_or(false);
    let is_wayland_session = session_type
        .map(|v| v.to_string_lossy().trim().eq_ignore_ascii_case("wayland"))
        .unwrap_or(false);

    (has_wayland_socket || is_wayland_session).then_some(LINUX_WAYLAND_GDK_BACKEND)
}

#[cfg(any(test, target_os = "linux"))]
fn apply_linux_gdk_backend() {
    if let Some(backend) = wayland_gdk_backend(
        std::env::var_os("GDK_BACKEND").as_deref(),
        std::env::var_os("WAYLAND_DISPLAY").as_deref(),
        std::env::var_os("XDG_SESSION_TYPE").as_deref(),
    ) {
        std::env::set_var("GDK_BACKEND", backend);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_linux_webkit_overrides();
    #[cfg(target_os = "linux")]
    apply_linux_gdk_backend();

    let builder = tauri::Builder::default();
    #[cfg(feature = "diagram-isolation-spike")]
    let builder = diagram_spike::configure(builder);
    builder
        .register_uri_scheme_protocol(PRINT_SCHEME, |ctx, _request| {
            let html = ctx
                .app_handle()
                .state::<PrintHtmlState>()
                .0
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_default();
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(html.into_bytes())
                .unwrap()
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A second instance can contain several file-association paths.
            if let Some(window) = app.get_webview_window("main") {
                // Bring window to front even if minimized (#49)
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
                if !window.is_visible().unwrap_or(true) {
                    let _ = window.show();
                }
                let _ = window.set_focus();
            }
            queue_open_files(app, paths_from_args(args, Some(Path::new(&cwd))));
        }))
        .manage(OpenFileState::default())
        .manage(native_files::NativeFiles::default())
        .manage(OpenFilesRegistry::default())
        .manage(PrintHtmlState(Mutex::new(None)))
        .manage(ai::process::ChildRegistry::new())
        .invoke_handler(move |invoke| {
            let webview = invoke.message.webview_ref();
            if !native_files::allows_custom_ipc(webview.app_handle(), webview.label(), webview.window().label()) {
                #[cfg(feature = "diagram-isolation-spike")]
                diagram_spike::record_denied_ipc(webview.label(), invoke.message.command());
                invoke.resolver.reject(serde_json::json!({
                    "code": "permission_required", "message": "Editor window required"
                }));
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            native_files::native_get_pending_transfers,
            native_files::native_ack_tab_transfer,
            native_files::native_get_grant,
            native_files::native_take_drops,
            native_files::native_read_grant,
            native_files::native_read_path,
            native_files::native_resolve_image_document,
            native_files::native_read_document_image,
            native_files::native_watch_subscribe,
            native_files::native_watch_read,
            native_files::native_watch_unsubscribe,
            native_files::native_list_directory,
            native_files::native_pick_documents,
            native_files::native_pick_save_destination,
            native_files::native_pick_workspace,
            native_files::native_pick_resource,
            native_files::native_pick_images,
            get_open_file_path,
            get_open_file_paths,
            create_new_window,
            get_all_windows,
            get_current_window_label,
            print_document,
            transfer_tab_to_window,
            register_open_file,
            unregister_open_file,
            unregister_window_files,
            check_file_open,
            focus_window_with_file,
            list_system_fonts,
            native_files::read_workspace_tree,
            native_files::create_md_file,
            native_files::create_folder,
            native_files::rename_path,
            native_files::delete_path,
            native_files::reveal_in_os,
            native_files::search_workspace_content,
            ai_health_check,
            ai_ollama_models,
            ai_openai_models,
            ai_codex_models,
            ai_access_load,
            ai_access_save,
            ai_access_migrate,
            ai_session_get,
            ai_session_upsert,
            ai_session_remove,
            ai_session_migrate,
            ai_session_recover_by_hash,
            ai_snapshot_list,
            ai_snapshot_create,
            ai_snapshot_restore,
            ai_snapshot_set_pinned,
            ai_snapshot_delete,
            ai_snapshot_export,
            ai_snapshot_migrate,
            ai_audit_append,
            ai_audit_read,
            ai_audit_clear,
            ai_send,
            ai_cancel,
            ai_image_save
            ];
            handler(invoke)
        })
        .setup(|app| {
            #[cfg(feature = "diagram-isolation-spike")]
            diagram_spike::setup(app)?;
            if app.get_webview_window("main").is_some() {
                native_files::register_editor(app.handle(), "main")?;
            }
            // Check for CLI arguments (file association on first launch)
            let cwd = std::env::current_dir().ok();
            let args = std::env::args_os().map(|argument| argument.into_string().unwrap_or_default());
            queue_open_files(app.handle(), paths_from_args(args, cwd.as_deref()));

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                RunEvent::ExitRequested { .. } => {
                    if let Some(reg) = app.try_state::<ai::process::ChildRegistry>() {
                        reg.kill_all();
                    }
                }
                #[cfg(target_os = "macos")]
                RunEvent::Opened { urls } => {
                    // macOS: Finder double-click on already-running app dispatches
                    // NSApplicationDelegate application:openURLs: (no new process,
                    // so single_instance plugin never fires). Handle it here. (#63)
                    let file_paths: Vec<String> = urls
                        .into_iter()
                        .filter_map(|url| url.to_file_path().ok())
                        .filter(|path| open_files::is_supported_markdown_path(path))
                        .filter_map(|path| path.into_os_string().into_string().ok())
                        .collect();

                    if file_paths.is_empty() {
                        return;
                    }

                    // Always queue every pending file before touching the window.
                    // On cold start macOS can deliver Opened before the webview is
                    // ready, and the frontend later drains these requests.
                    queue_open_files(app, file_paths);

                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_minimized().unwrap_or(false) {
                            let _ = window.unminimize();
                        }
                        if !window.is_visible().unwrap_or(true) {
                            let _ = window.show();
                        }
                        let _ = window.set_focus();
                    }
                }
                RunEvent::WindowEvent { label, event: WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }), .. } => {
                    native_files::native_drop(app, &label, &paths, position);
                }
                RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } => {
                    native_files::revoke_editor(app, &label);
                    // Webview destruction does not guarantee Vue unmount hooks.
                    // Keep remaining windows able to reopen these documents.
                    app.state::<OpenFilesRegistry>().remove_window(&label);
                    // The old owner may have closed before handling its wakeup.
                    // Exclude it even if Tauri has not removed its registry entry yet.
                    notify_pending_open_files(app, Some(&label));
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn webkit_override_applies_when_unset_or_blank() {
        assert!(should_apply_webkit_override(None));
        assert!(should_apply_webkit_override(Some(OsStr::new(""))));
        assert!(should_apply_webkit_override(Some(OsStr::new("   "))));
    }

    #[test]
    fn webkit_override_respects_explicit_user_value() {
        assert!(!should_apply_webkit_override(Some(OsStr::new("1"))));
        assert!(!should_apply_webkit_override(Some(OsStr::new("0"))));
    }

    #[test]
    fn linux_webkit_overrides_target_known_egl_workaround_vars() {
        let keys: Vec<&str> = LINUX_WEBKIT_RENDER_OVERRIDES.iter().map(|o| o.key).collect();
        assert_eq!(
            keys,
            ["WEBKIT_DISABLE_DMABUF_RENDERER", "WEBKIT_DISABLE_COMPOSITING_MODE"]
        );
        assert!(LINUX_WEBKIT_RENDER_OVERRIDES.iter().all(|o| o.value == "1"));
        // Symbol must build on every platform so the Linux applier is type-checked in CI.
        let _f: fn() = apply_linux_webkit_overrides;
    }

    #[test]
    fn reveal_arg_quotes_the_path_not_the_whole_switch() {
        assert_eq!(
            windows_reveal_arg(r"C:\Users\edy\My Notes\a.md"),
            "/select,\"C:\\Users\\edy\\My Notes\\a.md\""
        );
        assert_eq!(
            windows_reveal_arg(r"C:\notes\a.md"),
            "/select,\"C:\\notes\\a.md\""
        );
    }

    #[test]
    fn reveal_arg_normalizes_forward_slashes() {
        assert_eq!(
            windows_reveal_arg("C:/Users/edy/My Notes/a.md"),
            "/select,\"C:\\Users\\edy\\My Notes\\a.md\""
        );
    }

    #[test]
    fn reveal_arg_keeps_unc_paths_intact() {
        assert_eq!(
            windows_reveal_arg(r"\\server\share\notes\a.md"),
            "/select,\"\\\\server\\share\\notes\\a.md\""
        );
        assert_eq!(
            windows_reveal_arg("//server/share/notes/a.md"),
            "/select,\"\\\\server\\share\\notes\\a.md\""
        );
    }

    #[test]
    fn reveal_arg_opens_roots_instead_of_selecting_them() {
        assert_eq!(windows_reveal_arg(r"C:\"), "\"C:\\\"");
        assert_eq!(windows_reveal_arg("C:"), "\"C:\\\"");
        assert_eq!(windows_reveal_arg("d:/"), "\"d:\\\"");
        assert_eq!(windows_reveal_arg(r"\\server\share"), "\"\\\\server\\share\"");
        assert_eq!(windows_reveal_arg("//server/share/"), "\"\\\\server\\share\"");
    }

    #[test]
    fn reveal_arg_drops_trailing_separator_on_folders() {
        // A trailing `\` before the closing quote would read as an escaped quote.
        assert_eq!(
            windows_reveal_arg(r"C:\Users\edy\My Notes\"),
            "/select,\"C:\\Users\\edy\\My Notes\""
        );
    }

    #[test]
    fn reveal_arg_preserves_non_ascii_names() {
        assert_eq!(
            windows_reveal_arg(r"C:\Notatki\zażółć gęślą jaźń.md"),
            "/select,\"C:\\Notatki\\zażółć gęślą jaźń.md\""
        );
    }

    #[test]
    fn reveal_root_rejects_paths_below_a_share() {
        assert_eq!(windows_reveal_root(r"\\server\share\notes"), None);
        assert_eq!(windows_reveal_root(r"C:\notes"), None);
    }

    #[test]
    fn gdk_backend_prefers_wayland_when_socket_is_present() {
        assert_eq!(
            wayland_gdk_backend(None, Some(OsStr::new("wayland-0")), None),
            Some("wayland,x11")
        );
    }

    #[test]
    fn gdk_backend_prefers_wayland_for_wayland_session_type() {
        assert_eq!(
            wayland_gdk_backend(None, None, Some(OsStr::new("Wayland"))),
            Some("wayland,x11")
        );
    }

    #[test]
    fn gdk_backend_untouched_without_wayland_session() {
        assert_eq!(wayland_gdk_backend(None, None, None), None);
        assert_eq!(
            wayland_gdk_backend(None, Some(OsStr::new("  ")), Some(OsStr::new("x11"))),
            None
        );
    }

    #[test]
    fn gdk_backend_respects_explicit_user_value() {
        assert_eq!(
            wayland_gdk_backend(
                Some(OsStr::new("x11")),
                Some(OsStr::new("wayland-0")),
                Some(OsStr::new("wayland"))
            ),
            None
        );
        assert_eq!(
            wayland_gdk_backend(
                Some(OsStr::new("broadway")),
                Some(OsStr::new("wayland-0")),
                None
            ),
            None
        );
    }

    #[test]
    fn gdk_backend_applies_over_blank_value_and_keeps_x11_fallback() {
        assert_eq!(
            wayland_gdk_backend(Some(OsStr::new("   ")), Some(OsStr::new("wayland-0")), None),
            Some("wayland,x11")
        );
        assert!(LINUX_WAYLAND_GDK_BACKEND.ends_with(",x11"));
        // Symbol must build on every platform so the Linux applier is type-checked in CI.
        let _f: fn() = apply_linux_gdk_backend;
    }
}
