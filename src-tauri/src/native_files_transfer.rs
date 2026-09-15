//! Host-only copy and window-creation lifecycle. No renderer grant creation.
use super::*;
use crate::file_access::GrantId;

pub(crate) struct FileCopy {
    target: String,
    generation: Uuid,
    pub(super) id: GrantId,
    previous: Vec<((String, String), Option<GrantInfo>)>,
}
impl NativeState {
    fn reserve_editor(&mut self, label: &str) -> Result<(), String> {
        if crate::open_files::document_window_number(label).is_none()
            || self.windows.contains_key(label)
            || !self.building.insert(label.to_owned())
        {
            return Err("permission_required".into());
        }
        Ok(())
    }
    fn activate_editor(&mut self, label: &str) -> Result<(), String> {
        if !self.building.remove(label) {
            return Err("permission_required".into());
        }
        self.register(label)
    }
    pub(super) fn copy_file(
        &mut self,
        source: &str,
        target: &str,
        path: &str,
    ) -> Result<FileCopy, String> {
        self.generation(source)?;
        let generation = self.generation(target)?;
        if source == target {
            return Err("permission_required".into());
        }
        let info = self
            .owned
            .get(&(source.to_owned(), path.to_owned()))
            .ok_or("permission_required")?
            .clone();
        let copy = self
            .access
            .transfer_file(source, target, info.id, info.rights)
            .map_err(|e| e.to_string())?;
        let mut aliases = vec![
            path.to_owned(),
            copy.selected_path.to_string_lossy().into_owned(),
        ];
        aliases.sort();
        aliases.dedup();
        let previous = aliases
            .into_iter()
            .map(|path| {
                let key = (target.to_owned(), path);
                let old = self.owned.get(&key).cloned();
                (key, old)
            })
            .collect();
        let id = copy.id;
        self.remember(target, Path::new(path), copy);
        Ok(FileCopy {
            target: target.into(),
            generation,
            id,
            previous,
        })
    }
    pub(super) fn rollback_copy(&mut self, copy: FileCopy) {
        if self.generation(&copy.target).ok() != Some(copy.generation) {
            return;
        }
        self.access.revoke(&copy.target, copy.id);
        for (key, old) in copy.previous {
            // A newer native selection must not be erased by delayed rollback.
            if self.owned.get(&key).is_some_and(|info| info.id == copy.id) {
                if let Some(old) =
                    old.filter(|info| self.access.describe(&copy.target, info.id).is_ok())
                {
                    self.owned.insert(key, old);
                } else {
                    self.owned.remove(&key);
                }
            }
        }
    }
}

pub(crate) fn reserve_editor(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    app.state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .reserve_editor(label)
}
pub(crate) fn activate_editor(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    app.state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .activate_editor(label)
}
pub(crate) fn cancel_editor_reservation(app: &tauri::AppHandle, label: &str) {
    if let Ok(mut state) = app.state::<NativeFiles>().0.lock() {
        state.building.remove(label);
    }
}
#[cfg(test)]
#[path = "native_files_transfer_tests.rs"]
mod tests;
