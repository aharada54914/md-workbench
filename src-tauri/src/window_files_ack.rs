//! Async waiting owns cleanup, including cancellation of the invoke future.
use super::*;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const TRANSFER_ACK_TIMEOUT: Duration = Duration::from_secs(60);
pub(super) struct TransferWait {
    app: tauri::AppHandle,
    pub(super) payload: native_files::PendingTabTransfer,
    receiver: Option<oneshot::Receiver<Result<(), String>>>,
    deadline: Instant,
}
impl TransferWait {
    pub(super) fn begin(
        app: &tauri::AppHandle,
        source: &str,
        target: &str,
        path: &str,
    ) -> Result<Self, String> {
        let transfer = native_files::begin_tab_transfer(app, source, target, path)?;
        app.state::<OpenFilesRegistry>()
            .add_transfer(&transfer.payload);
        Ok(Self {
            app: app.clone(),
            payload: transfer.payload,
            receiver: Some(transfer.receiver),
            deadline: Instant::now() + TRANSFER_ACK_TIMEOUT,
        })
    }
    pub(super) async fn wait(mut self) -> Result<(), String> {
        let receiver = self.receiver.take().ok_or("transfer_cancelled")?;
        let timeout = self.deadline.saturating_duration_since(Instant::now());
        await_completion(receiver, timeout, || {
            native_files::cancel_tab_transfer(&self.app, &self.payload.id, "transfer_timeout")
        })
        .await
    }
}
impl Drop for TransferWait {
    fn drop(&mut self) {
        let _ =
            native_files::cancel_tab_transfer(&self.app, &self.payload.id, "transfer_cancelled");
        self.app
            .state::<OpenFilesRegistry>()
            .remove_transfer(&self.payload.id);
    }
}
async fn await_completion(
    mut receiver: oneshot::Receiver<Result<(), String>>,
    timeout: Duration,
    expire: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    match tokio::time::timeout(timeout, &mut receiver).await {
        Ok(result) => result.unwrap_or_else(|_| Err("transfer_cancelled".into())),
        Err(_) => {
            // Expiry races the ACK under NativeState's single lock. If ACK has
            // already won, expiry does nothing and this receives that success.
            expire()?;
            receiver
                .await
                .unwrap_or_else(|_| Err("transfer_cancelled".into()))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn timeout_returns_the_result_of_the_atomic_completion_winner() {
        let (sender, receiver) = oneshot::channel();
        let result = await_completion(receiver, Duration::ZERO, || {
            // Simulate an ACK winning the state lock just before expiry enters.
            sender.send(Ok(())).unwrap();
            Ok(())
        })
        .await;
        assert!(result.is_ok());
        let (sender, receiver) = oneshot::channel();
        let result = await_completion(receiver, Duration::ZERO, || {
            sender.send(Err("transfer_timeout".into())).unwrap();
            Ok(())
        })
        .await;
        assert_eq!(result.unwrap_err(), "transfer_timeout");
    }
    #[tokio::test]
    async fn unavailable_state_at_timeout_fails_without_waiting_forever() {
        let (_sender, receiver) = oneshot::channel();
        assert_eq!(
            await_completion(receiver, Duration::ZERO, || Err(
                "native_state_unavailable".into()
            ))
            .await
            .unwrap_err(),
            "native_state_unavailable"
        );
    }
    #[tokio::test]
    async fn completed_ack_does_not_invoke_expiry() {
        let (sender, receiver) = oneshot::channel();
        sender.send(Ok(())).unwrap();
        assert!(
            await_completion(receiver, Duration::from_secs(60), || panic!(
                "unexpected timeout"
            ))
            .await
            .is_ok()
        );
    }
}

// Own the new window until all preparation and (when applicable) target ACK
// succeed. Future cancellation must also roll back a partially created editor.
pub(super) struct CreatedEditor(Option<tauri::WebviewWindow>);
impl CreatedEditor {
    pub(super) fn new(window: tauri::WebviewWindow) -> Self {
        Self(Some(window))
    }
    pub(super) fn commit(&mut self) {
        self.0 = None;
    }
}
impl Drop for CreatedEditor {
    fn drop(&mut self) {
        if let Some(window) = self.0.take() {
            let app = window.app_handle();
            native_files::revoke_editor(app, window.label());
            app.state::<OpenFilesRegistry>()
                .remove_window(window.label());
            let _ = window.destroy();
            crate::notify_pending_open_files(app, Some(window.label()));
        }
    }
}
