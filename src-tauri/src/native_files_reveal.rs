//! Caller-owned reveal dispatch. OS managers re-resolve paths after launch;
//! this verifies authority/mapping before dispatch, not post-dispatch identity.
use super::*;
use std::io;

impl NativeState {
    fn reveal_path(
        &self,
        label: &str,
        generation: Uuid,
        path: &str,
        expected_grant_id: Option<&str>,
        launch: impl FnOnce(&Path) -> io::Result<()>,
    ) -> Result<(), String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let (id, relative) =
            self.resolve_expected_owned_path(label, path, false, expected_grant_id)?;
        self.access
            .reveal(label, id, Path::new(&relative), launch)
            .map_err(|e| e.to_string())
    }
}

// cap-std/native canonical paths on Windows use verbatim prefixes. Explorer
// expects ordinary drive/UNC spelling; only host-validated paths reach here.
#[cfg(any(test, windows))]
fn explorer_path(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(drive) = path.strip_prefix(r"\\?\") {
        drive.to_owned()
    } else {
        path.to_owned()
    }
}

#[cfg(any(test, all(unix, not(target_os = "macos"))))]
fn parent_or_root(target: &Path) -> &Path {
    target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(target)
}

fn launch_manager(target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let path = target
            .to_str()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid reveal path"))?;
        std::process::Command::new("explorer.exe")
            .raw_arg(crate::windows_reveal_arg(&explorer_path(path)))
            .spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if target.parent().is_some() {
            command.arg("-R");
        }
        command.arg(target).spawn()?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Open only a directory, never an arbitrary file/URI association.
        std::process::Command::new("xdg-open")
            .arg(parent_or_root(target))
            .spawn()?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "unsupported platform",
    ))
}

#[tauri::command]
pub(crate) async fn reveal_in_os(
    window: tauri::Window,
    path: String,
    expected_grant_id: Option<String>,
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
        // Keep authorization current through spawn; no handle or launch plan is
        // queued outside this lock. External filesystem writers are not locked.
        app.state::<NativeFiles>()
            .0
            .lock()
            .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
            .reveal_path(
                &label,
                generation,
                &path,
                expected_grant_id.as_deref(),
                launch_manager,
            )
            .map_err(Into::into)
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}

#[cfg(test)]
#[path = "native_files_reveal_tests.rs"]
mod tests;
