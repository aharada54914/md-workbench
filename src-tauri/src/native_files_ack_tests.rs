use super::*;
use std::fs;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("mdw-ack-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("doc.md"), b"unchanged").unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn path(&self) -> String {
        self.0.join("doc.md").to_str().unwrap().into()
    }
    fn state(&self) -> NativeState {
        let mut state = NativeState::default();
        for label in ["main", "window-1", "window-2"] {
            state.register(label).unwrap();
        }
        state
            .select(
                "main",
                state.generation("main").unwrap(),
                vec![self.path().into()],
                Purpose::Document,
            )
            .unwrap();
        state
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn pending_is_ordered_nondestructive_and_visible_only_to_actual_target() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let first = state
        .begin_transfer("main", "window-1", &fixture.path())
        .unwrap();
    let other = fixture.0.join("other.md");
    fs::write(&other, b"second").unwrap();
    state
        .select(
            "main",
            state.generation("main").unwrap(),
            vec![other.clone()],
            Purpose::Document,
        )
        .unwrap();
    let second = state
        .begin_transfer("main", "window-1", other.to_str().unwrap())
        .unwrap();
    assert!(state.pending_transfers("main").unwrap().is_empty());
    assert!(state.pending_transfers("window-2").unwrap().is_empty());
    assert!(state.pending_transfers("print-preview").is_err());
    for _ in 0..2 {
        let pending = state.pending_transfers("window-1").unwrap();
        assert_eq!(
            pending.iter().map(|p| &p.id).collect::<Vec<_>>(),
            vec![&first.payload.id, &second.payload.id]
        );
    }
    let json = serde_json::to_value(&first.payload).unwrap();
    assert_eq!(json["source_window"], "main");
    assert_eq!(json["target_window"], "window-1");
    assert!(json.get("file_path").is_some());
    assert_eq!(json.as_object().unwrap().len(), 4);
}
#[test]
fn ack_is_owned_single_use_and_keeps_both_capabilities_on_success() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let mut transfer = state
        .begin_transfer("main", "window-1", &fixture.path())
        .unwrap();
    assert_eq!(
        transfer.receiver.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    );
    for caller in ["main", "window-2"] {
        assert_eq!(
            state
                .ack_transfer(caller, &transfer.payload.id, true)
                .unwrap_err(),
            "permission_required"
        );
    }
    assert_eq!(state.transfers.len(), 1);
    state
        .ack_transfer("window-1", &transfer.payload.id, true)
        .unwrap();
    assert_eq!(transfer.receiver.try_recv().unwrap(), Ok(()));
    assert!(state.pending_transfers("window-1").unwrap().is_empty());
    assert_eq!(
        state
            .ack_transfer("window-1", &transfer.payload.id, true)
            .unwrap_err(),
        "transfer_not_found"
    );
    for owner in ["main", "window-1"] {
        let grant = state.lookup(owner, &fixture.path()).unwrap().unwrap();
        assert_eq!(
            state
                .access
                .read(
                    owner,
                    crate::file_access::GrantId::parse(&grant.id).unwrap(),
                    Path::new(""),
                    100
                )
                .unwrap(),
            b"unchanged"
        );
    }
}
#[test]
fn failure_and_expiry_revoke_only_copy_and_keep_source() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    for reason in [
        "transfer_open_failed",
        "transfer_timeout",
        "transfer_cancelled",
    ] {
        let mut transfer = state
            .begin_transfer("main", "window-1", &fixture.path())
            .unwrap();
        if reason == "transfer_open_failed" {
            state
                .ack_transfer("window-1", &transfer.payload.id, false)
                .unwrap();
        } else {
            state.finish_transfer(&transfer.payload.id, Err(reason.into()));
        }
        assert_eq!(transfer.receiver.try_recv().unwrap().unwrap_err(), reason);
        assert!(state.lookup("window-1", &fixture.path()).unwrap().is_none());
        assert!(state.lookup("main", &fixture.path()).unwrap().is_some());
        assert!(state.transfers.is_empty());
    }
    assert_eq!(fs::read(fixture.path()).unwrap(), b"unchanged");
}
#[test]
fn either_window_destruction_cancels_pending_and_reused_label_cannot_ack() {
    let fixture = Fixture::new();
    for closed in ["main", "window-1"] {
        let mut state = fixture.state();
        let mut transfer = state
            .begin_transfer("main", "window-1", &fixture.path())
            .unwrap();
        state.revoke(closed);
        assert_eq!(
            transfer.receiver.try_recv().unwrap().unwrap_err(),
            "transfer_window_closed"
        );
        state.register(closed).unwrap();
        assert!(state
            .ack_transfer("window-1", &transfer.payload.id, true)
            .is_err());
        assert!(state.transfers.is_empty());
        assert!(state.lookup("window-1", &fixture.path()).unwrap().is_none());
        if closed != "main" {
            assert!(state.lookup("main", &fixture.path()).unwrap().is_some());
        }
    }
}
#[test]
fn first_atomic_completion_wins_in_both_timeout_ack_orders() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let mut acknowledged = state
        .begin_transfer("main", "window-1", &fixture.path())
        .unwrap();
    state
        .ack_transfer("window-1", &acknowledged.payload.id, true)
        .unwrap();
    state.finish_transfer(&acknowledged.payload.id, Err("transfer_timeout".into()));
    assert_eq!(acknowledged.receiver.try_recv().unwrap(), Ok(()));
    let mut expired = state
        .begin_transfer("main", "window-2", &fixture.path())
        .unwrap();
    state.finish_transfer(&expired.payload.id, Err("transfer_timeout".into()));
    assert_eq!(
        state
            .ack_transfer("window-2", &expired.payload.id, true)
            .unwrap_err(),
        "transfer_not_found"
    );
    assert_eq!(
        expired.receiver.try_recv().unwrap().unwrap_err(),
        "transfer_timeout"
    );
    assert!(state.lookup("window-1", &fixture.path()).unwrap().is_some());
    assert!(state.lookup("window-2", &fixture.path()).unwrap().is_none());
}
#[test]
fn stale_generation_is_denied_even_if_lifecycle_cleanup_were_missed() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let transfer = state
        .begin_transfer("main", "window-1", &fixture.path())
        .unwrap();
    state.windows.insert("window-1".into(), Uuid::new_v4());
    assert!(state.pending_transfers("window-1").unwrap().is_empty());
    assert_eq!(
        state
            .ack_transfer("window-1", &transfer.payload.id, true)
            .unwrap_err(),
        "permission_required"
    );
}

#[test]
fn concurrent_ack_and_expiry_return_one_consistent_result() {
    use std::sync::{Arc, Barrier, Mutex};
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let mut transfer = state
        .begin_transfer("main", "window-1", &fixture.path())
        .unwrap();
    let state = Arc::new(Mutex::new(state));
    let barrier = Arc::new(Barrier::new(3));
    let acknowledged = std::thread::scope(|scope| {
        let state_ack = Arc::clone(&state);
        let barrier_ack = Arc::clone(&barrier);
        let id_ack = transfer.payload.id.clone();
        let ack = scope.spawn(move || {
            barrier_ack.wait();
            state_ack
                .lock()
                .unwrap()
                .ack_transfer("window-1", &id_ack, true)
        });
        let state_expiry = Arc::clone(&state);
        let barrier_expiry = Arc::clone(&barrier);
        let id_expiry = transfer.payload.id.clone();
        scope.spawn(move || {
            barrier_expiry.wait();
            state_expiry
                .lock()
                .unwrap()
                .finish_transfer(&id_expiry, Err("transfer_timeout".into()));
        });
        barrier.wait();
        let acknowledged = ack.join().unwrap().is_ok();
        // Joining the expiry thread occurs at scope exit; inspect after it below.
        acknowledged
    });
    let result = transfer.receiver.try_recv().unwrap();
    assert_eq!(acknowledged, result.is_ok());
    let state = state.lock().unwrap();
    assert!(state.transfers.is_empty());
    assert_eq!(
        state.lookup("window-1", &fixture.path()).unwrap().is_some(),
        result.is_ok()
    );
    assert!(state.lookup("main", &fixture.path()).unwrap().is_some());
    if let Err(error) = result {
        assert_eq!(error, "transfer_timeout");
    }
}

#[test]
fn duplicate_pending_aliases_are_rejected_and_failed_copy_restores_existing_target() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    state
        .select(
            "window-1",
            state.generation("window-1").unwrap(),
            vec![fixture.path().into()],
            Purpose::Resource,
        )
        .unwrap();
    let previous = state.lookup("window-1", &fixture.path()).unwrap().unwrap();
    // A native-selected spelling differs from the canonical metadata spelling.
    #[cfg(not(windows))]
    let alias = fixture.0.join(".").join("doc.md");
    // Joining a dot onto a Windows verbatim path normalizes it away. Use
    // the ordinary drive spelling to retain a distinct, equivalent alias.
    #[cfg(windows)]
    let alias = PathBuf::from(fixture.path().strip_prefix(r"\\?\").unwrap());
    state
        .select(
            "main",
            state.generation("main").unwrap(),
            vec![alias.clone()],
            Purpose::Document,
        )
        .unwrap();
    assert_ne!(alias.to_str().unwrap(), fixture.path());
    let mut first = state
        .begin_transfer("main", "window-1", alias.to_str().unwrap())
        .unwrap();
    let first_copy = state.lookup("window-1", &fixture.path()).unwrap().unwrap();
    for path in [alias.to_str().unwrap(), fixture.path().as_str()] {
        assert!(
            matches!(state.begin_transfer("main", "window-1", path), Err(error) if error == "transfer_in_progress")
        );
    }
    assert_eq!(state.transfers.len(), 1);
    assert_eq!(
        state
            .lookup("window-1", &fixture.path())
            .unwrap()
            .unwrap()
            .id,
        first_copy.id
    );
    assert_eq!(
        first.receiver.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    );
    state
        .ack_transfer("window-1", &first.payload.id, false)
        .unwrap();
    assert_eq!(
        first.receiver.try_recv().unwrap().unwrap_err(),
        "transfer_open_failed"
    );
    let restored = state.lookup("window-1", &fixture.path()).unwrap().unwrap();
    assert_eq!(restored.id, previous.id);
    assert!(restored.read);
    assert!(!restored.write);
    // Completion releases the exclusion, and another failed attempt still
    // restores X instead of an invalidated intermediate copy.
    let retry = state
        .begin_transfer("main", "window-1", &fixture.path())
        .unwrap();
    state.finish_transfer(&retry.payload.id, Err("transfer_timeout".into()));
    assert_eq!(
        state
            .lookup("window-1", &fixture.path())
            .unwrap()
            .unwrap()
            .id,
        previous.id
    );
    assert!(state.lookup("main", &fixture.path()).unwrap().is_some());
}
