//! Reliable tab-transfer delivery: a notification never acknowledges a read.
use super::*;
use tokio::sync::oneshot;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct PendingTabTransfer {
    pub(crate) id: String,
    pub(crate) file_path: String,
    pub(crate) source_window: String,
    pub(crate) target_window: String,
}
pub(super) struct PendingTransfer {
    payload: PendingTabTransfer,
    source_generation: Uuid,
    target_generation: Uuid,
    selected_path: PathBuf,
    copy: FileCopy,
    completion: oneshot::Sender<Result<(), String>>,
}
pub(crate) struct TransferReceiver {
    pub(crate) payload: PendingTabTransfer,
    pub(crate) receiver: oneshot::Receiver<Result<(), String>>,
}
impl NativeState {
    fn begin_transfer(
        &mut self,
        source: &str,
        target: &str,
        path: &str,
    ) -> Result<TransferReceiver, String> {
        let source_generation = self.generation(source)?;
        let target_generation = self.generation(target)?;
        let selected_path = self
            .owned
            .get(&(source.to_owned(), path.to_owned()))
            .ok_or("permission_required")?
            .selected_path
            .clone();
        // One pending copy per target/document keeps rollback's previous alias
        // stable. Compare the owned canonical metadata, never recanonicalize an
        // untrusted path, so original/native aliases cannot bypass this guard.
        if self.transfers.iter().any(|entry| {
            entry.payload.target_window == target && entry.selected_path == selected_path
        }) {
            return Err("transfer_in_progress".into());
        }
        let copy = self.copy_file(source, target, path)?;
        let payload = PendingTabTransfer {
            id: Uuid::new_v4().to_string(),
            file_path: path.into(),
            source_window: source.into(),
            target_window: target.into(),
        };
        let (completion, receiver) = oneshot::channel();
        self.transfers.push(PendingTransfer {
            payload: payload.clone(),
            source_generation,
            target_generation,
            selected_path,
            copy,
            completion,
        });
        Ok(TransferReceiver { payload, receiver })
    }
    fn pending_transfers(&self, target: &str) -> Result<Vec<PendingTabTransfer>, String> {
        let generation = self.generation(target)?;
        Ok(self
            .transfers
            .iter()
            .filter(|entry| {
                entry.payload.target_window == target
                    && entry.target_generation == generation
                    && self.generation(&entry.payload.source_window).ok()
                        == Some(entry.source_generation)
            })
            .map(|entry| entry.payload.clone())
            .collect())
    }
    fn ack_transfer(&mut self, target: &str, id: &str, success: bool) -> Result<(), String> {
        let generation = self.generation(target)?;
        let entry = self
            .transfers
            .iter()
            .find(|entry| entry.payload.id == id)
            .ok_or("transfer_not_found")?;
        if entry.payload.target_window != target || entry.target_generation != generation {
            return Err("permission_required".into());
        }
        if self.generation(&entry.payload.source_window).ok() != Some(entry.source_generation) {
            self.finish_transfer(id, Err("transfer_window_closed".into()));
            return Err("transfer_window_closed".into());
        }
        self.finish_transfer(
            id,
            if success {
                Ok(())
            } else {
                Err("transfer_open_failed".into())
            },
        );
        Ok(())
    }
    // The same lock arbitrates ACK, timeout and destruction. Only its first winner
    // can consume the pending entry and send the authoritative completion result.
    fn finish_transfer(&mut self, id: &str, result: Result<(), String>) {
        let Some(index) = self
            .transfers
            .iter()
            .position(|entry| entry.payload.id == id)
        else {
            return;
        };
        let entry = self.transfers.remove(index);
        if result.is_err() {
            self.rollback_copy(entry.copy);
        }
        let _ = entry.completion.send(result);
    }
    pub(super) fn cancel_window_transfers(&mut self, label: &str) {
        let ids: Vec<_> = self
            .transfers
            .iter()
            .filter(|entry| {
                entry.payload.source_window == label || entry.payload.target_window == label
            })
            .map(|entry| entry.payload.id.clone())
            .collect();
        for id in ids {
            self.finish_transfer(&id, Err("transfer_window_closed".into()));
        }
    }
}
pub(crate) fn begin_tab_transfer(
    app: &tauri::AppHandle,
    source: &str,
    target: &str,
    path: &str,
) -> Result<TransferReceiver, String> {
    app.state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .begin_transfer(source, target, path)
}
pub(crate) fn cancel_tab_transfer(
    app: &tauri::AppHandle,
    id: &str,
    reason: &str,
) -> Result<(), String> {
    app.state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .finish_transfer(id, Err(reason.into()));
    Ok(())
}
#[tauri::command]
pub(crate) fn native_get_pending_transfers(
    window: tauri::Window,
) -> Result<Vec<PendingTabTransfer>, String> {
    window
        .state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .pending_transfers(window.label())
}
#[tauri::command]
pub(crate) fn native_ack_tab_transfer(
    window: tauri::Window,
    id: String,
    success: bool,
) -> Result<(), String> {
    window
        .state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .ack_transfer(window.label(), &id, success)
}
#[cfg(test)]
#[path = "native_files_ack_tests.rs"]
mod tests;
