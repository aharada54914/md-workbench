//! HTTP(S)-only OS browser dispatch from a live editor. No shell command text,
//! file association, caller-selected executable, or renderer window identity.
use super::*;
use std::io;

const MAX_URL_BYTES: usize = 8192;

fn http_url(input: &str) -> Result<tauri::Url, String> {
    if input.len() > MAX_URL_BYTES
        || input
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
        || !input.split_once("://").is_some_and(|(scheme, rest)| {
            (scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
                && !rest.is_empty()
                && !rest.starts_with('/')
        })
    {
        return Err("invalid_url".into());
    }
    let url = tauri::Url::parse(input).map_err(|_| "invalid_url")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("invalid_url".into());
    }
    Ok(url)
}

impl NativeState {
    fn open_http_link(
        &self,
        label: &str,
        generation: Uuid,
        url: &str,
        launch: impl FnOnce(&str) -> io::Result<()>,
    ) -> Result<(), String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let parsed = http_url(url)?;
        launch(parsed.as_str()).map_err(|_| "open_failed".into())
    }
}

fn launch_browser(url: &str) -> io::Result<Option<std::process::Child>> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Com::{
            CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
        };
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        // Shell handlers can require STA COM on this actual worker thread.
        let initialized = unsafe {
            CoInitializeEx(
                std::ptr::null(),
                (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
            )
        };
        if initialized < 0 {
            return Err(io::Error::other("browser COM initialization failed"));
        }
        struct ComGuard;
        impl Drop for ComGuard {
            fn drop(&mut self) {
                unsafe { CoUninitialize() };
            }
        }
        let _com = ComGuard;
        let target: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        // Both strings are NUL-free, terminated, and live for this call. Pass
        // the URL as the target, with no parameters or command interpreter.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        return if result > 32 {
            Ok(None)
        } else {
            Err(io::Error::other("browser dispatch failed"))
        };
    }
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("/usr/bin/open")
            .arg(url)
            .spawn()
            .map(Some);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map(Some);
    }
    #[allow(unreachable_code)]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "unsupported platform",
    ))
}

#[tauri::command]
pub(crate) async fn native_open_external_link(
    window: tauri::Window,
    url: String,
) -> Result<(), String> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let generation = app
        .state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .generation(&label)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Keep the originating registration live through OS dispatch, including
        // a close/recreate that occurs while the blocking task is queued.
        let mut opener = None;
        let result = app
            .state::<NativeFiles>()
            .0
            .lock()
            .map_err(|_| "native_state_unavailable")?
            .open_http_link(&label, generation, &url, |url| {
                opener = launch_browser(url)?;
                Ok(())
            });
        // The registration lock is released before waiting. Dropping the task
        // handle detaches the reaper; Unix Child itself does not reap on Drop.
        if let Some(mut child) = opener {
            tauri::async_runtime::spawn_blocking(move || {
                let _ = child.wait();
            });
        }
        result
    })
    .await
    .map_err(|_| "native_state_unavailable")?
}

#[cfg(test)]
#[path = "native_files_external_link_tests.rs"]
mod tests;
