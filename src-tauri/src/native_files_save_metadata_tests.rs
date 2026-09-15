use super::*;
use crate::file_access::GrantId;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-save-metadata-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("live")).unwrap();
        fs::write(root.join("live/doc.md"), b"original").unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn path(&self) -> String {
        self.0.join("live/doc.md").to_str().unwrap().into()
    }
    fn state(&self) -> NativeState {
        let mut state = NativeState::default();
        for label in ["main", "window-1"] {
            state.register(label).unwrap();
        }
        state
    }
    fn select(&self, state: &mut NativeState, owner: &str, purpose: Purpose) -> NativeGrant {
        state
            .select(
                owner,
                state.generation(owner).unwrap(),
                vec![self.path().into()],
                purpose,
            )
            .unwrap()
            .remove(0)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn read(state: &NativeState, owner: &str, path: &str) -> Vec<u8> {
    let (id, relative) = state.resolve_owned_path(owner, path, false).unwrap();
    state
        .access
        .read(owner, id, Path::new(&relative), 100)
        .unwrap()
}

#[test]
fn ack_rejects_a_read_binding_reselected_while_transfer_is_pending() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let source = fixture.select(&mut state, "main", Purpose::Document);
    let mut pending = state
        .begin_transfer("main", "window-1", &fixture.path())
        .unwrap();
    let newer = fixture.select(&mut state, "window-1", Purpose::Resource);
    assert_eq!(
        state
            .ack_transfer("window-1", &pending.payload.id, true)
            .unwrap_err(),
        "transfer_grant_changed"
    );
    assert_eq!(
        pending.receiver.try_recv().unwrap().unwrap_err(),
        "transfer_grant_changed"
    );
    assert_eq!(
        state
            .lookup("window-1", &fixture.path())
            .unwrap()
            .unwrap()
            .id,
        newer.id
    );
    assert_eq!(
        state.lookup("main", &fixture.path()).unwrap().unwrap().id,
        source.id
    );
    assert!(!newer.write);
    assert!(state.transfers.is_empty());
}

#[test]
fn save_keeps_read_transfer_and_source_rights_without_reviving_document_rights() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    fixture.select(&mut state, "main", Purpose::Document);
    let resource = fixture.select(&mut state, "main", Purpose::Resource);
    let save = fixture.select(&mut state, "main", Purpose::Save);
    assert_eq!(
        state.lookup("main", &fixture.path()).unwrap().unwrap().id,
        resource.id
    );
    assert_eq!(read(&state, "main", &fixture.path()), b"original");
    assert!(!resource.write);
    assert!(!save.read);
    assert!(state
        .access
        .read(
            "main",
            GrantId::parse(&save.id).unwrap(),
            Path::new(""),
            100
        )
        .is_err());
    let mut pending = state
        .begin_transfer("main", "window-1", &fixture.path())
        .unwrap();
    let copied = state.lookup("window-1", &fixture.path()).unwrap().unwrap();
    assert!(copied.read);
    assert!(!copied.write);
    state
        .ack_transfer("window-1", &pending.payload.id, true)
        .unwrap();
    assert_eq!(pending.receiver.try_recv().unwrap(), Ok(()));
    assert_eq!(
        state.lookup("main", &fixture.path()).unwrap().unwrap().id,
        resource.id
    );
    assert!(state
        .access
        .describe("main", GrantId::parse(&resource.id).unwrap())
        .is_ok());
}

#[test]
fn save_only_is_lookup_fallback_but_cannot_read_or_transfer_and_revoke_clears_both_maps() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let save = fixture.select(&mut state, "main", Purpose::Save);
    assert_eq!(
        state.lookup("main", &fixture.path()).unwrap().unwrap().id,
        save.id
    );
    assert!(state
        .resolve_owned_path("main", &fixture.path(), false)
        .is_err());
    assert!(state
        .begin_transfer("main", "window-1", &fixture.path())
        .is_err());
    assert!(state.lookup("window-1", &fixture.path()).unwrap().is_none());
    let document = fixture.select(&mut state, "main", Purpose::Document);
    assert_eq!(
        state.lookup("main", &fixture.path()).unwrap().unwrap().id,
        document.id
    );
    state.revoke("main");
    state.register("main").unwrap();
    assert!(state.lookup("main", &fixture.path()).unwrap().is_none());
    for old in [save, document] {
        assert!(state
            .access
            .describe("main", GrantId::parse(&old.id).unwrap())
            .is_err());
    }
    assert!(state.save_exports.is_empty());
    assert!(state.owned.is_empty());
}

#[test]
fn failed_batches_and_empty_selection_leave_both_metadata_maps_unchanged() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let document = fixture.select(&mut state, "main", Purpose::Document);
    let save = fixture.select(&mut state, "main", Purpose::Save);
    let generation = state.generation("main").unwrap();
    for purpose in [Purpose::Document, Purpose::Save] {
        let invalid = fixture.0.join("missing-parent/doc.md");
        assert!(state
            .select(
                "main",
                generation,
                vec![fixture.path().into(), invalid],
                purpose
            )
            .is_err());
        assert!(state
            .select("main", generation, vec![], purpose)
            .unwrap()
            .is_empty());
        assert_eq!(
            state.lookup("main", &fixture.path()).unwrap().unwrap().id,
            document.id
        );
        assert_eq!(
            state
                .save_exports
                .get(&("main".into(), fixture.path()))
                .unwrap()
                .id,
            GrantId::parse(&save.id).unwrap()
        );
        assert_eq!(read(&state, "main", &fixture.path()), b"original");
    }
}

#[test]
fn save_during_pending_transfer_survives_success_failure_and_timeout() {
    let fixture = Fixture::new();
    for outcome in ["success", "failure", "timeout"] {
        let mut state = fixture.state();
        let source = fixture.select(&mut state, "main", Purpose::Document);
        let previous = fixture.select(&mut state, "window-1", Purpose::Resource);
        let mut pending = state
            .begin_transfer("main", "window-1", &fixture.path())
            .unwrap();
        let copied = state.lookup("window-1", &fixture.path()).unwrap().unwrap();
        let save = fixture.select(&mut state, "window-1", Purpose::Save);
        if outcome == "timeout" {
            state.finish_transfer(&pending.payload.id, Err("transfer_timeout".into()));
        } else {
            state
                .ack_transfer("window-1", &pending.payload.id, outcome == "success")
                .unwrap();
        }
        assert_eq!(
            pending.receiver.try_recv().unwrap().is_ok(),
            outcome == "success"
        );
        let current = state.lookup("window-1", &fixture.path()).unwrap().unwrap();
        assert_eq!(
            current.id,
            if outcome == "success" {
                copied.id
            } else {
                previous.id
            }
        );
        assert_eq!(
            state
                .save_exports
                .get(&("window-1".into(), fixture.path()))
                .unwrap()
                .id,
            GrantId::parse(&save.id).unwrap()
        );
        assert_eq!(
            state.lookup("main", &fixture.path()).unwrap().unwrap().id,
            source.id
        );
        assert_eq!(read(&state, "window-1", &fixture.path()), b"original");
    }
}

#[cfg(unix)]
#[test]
fn same_path_save_retains_a_different_parent_without_redirecting_document_or_transfer() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let document = fixture.select(&mut state, "main", Purpose::Document);
    fs::rename(fixture.0.join("live"), fixture.0.join("old")).unwrap();
    fs::create_dir(fixture.0.join("live")).unwrap();
    let save = fixture.select(&mut state, "main", Purpose::Save);
    state
        .access
        .create_new(
            "main",
            GrantId::parse(&save.id).unwrap(),
            Path::new(""),
            b"new",
        )
        .unwrap();
    assert_eq!(fs::read(fixture.path()).unwrap(), b"new");
    assert_eq!(read(&state, "main", &fixture.path()), b"original");
    assert_eq!(
        state.lookup("main", &fixture.path()).unwrap().unwrap().id,
        document.id
    );
    let mut pending = state
        .begin_transfer("main", "window-1", &fixture.path())
        .unwrap();
    assert_eq!(read(&state, "window-1", &fixture.path()), b"original");
    state
        .ack_transfer("window-1", &pending.payload.id, true)
        .unwrap();
    assert_eq!(pending.receiver.try_recv().unwrap(), Ok(()));
    let newer = fixture.select(&mut state, "main", Purpose::Document);
    assert_ne!(newer.id, document.id);
    assert_eq!(read(&state, "main", &fixture.path()), b"new");
    assert_eq!(read(&state, "window-1", &fixture.path()), b"original");
}

#[cfg(unix)]
#[test]
fn ack_does_not_accept_the_new_parent_selected_at_the_pending_path() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    fixture.select(&mut state, "main", Purpose::Document);
    let mut pending = state
        .begin_transfer("main", "window-1", &fixture.path())
        .unwrap();
    fs::rename(fixture.0.join("live"), fixture.0.join("old")).unwrap();
    fs::create_dir(fixture.0.join("live")).unwrap();
    fs::write(fixture.path(), b"replacement").unwrap();
    let newer = fixture.select(&mut state, "window-1", Purpose::Document);
    assert_eq!(read(&state, "window-1", &fixture.path()), b"replacement");
    assert_eq!(
        state
            .ack_transfer("window-1", &pending.payload.id, true)
            .unwrap_err(),
        "transfer_grant_changed"
    );
    assert!(pending.receiver.try_recv().unwrap().is_err());
    assert_eq!(
        state
            .lookup("window-1", &fixture.path())
            .unwrap()
            .unwrap()
            .id,
        newer.id
    );
    assert_eq!(read(&state, "main", &fixture.path()), b"original");
}

#[test]
fn newer_save_replaces_only_export_and_failed_transfer_restores_save_only_lookup() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    fixture.select(&mut state, "main", Purpose::Document);
    let first = fixture.select(&mut state, "window-1", Purpose::Save);
    let mut pending = state
        .begin_transfer("main", "window-1", &fixture.path())
        .unwrap();
    let latest = fixture.select(&mut state, "window-1", Purpose::Save);
    assert_ne!(first.id, latest.id);
    state
        .ack_transfer("window-1", &pending.payload.id, false)
        .unwrap();
    assert!(pending.receiver.try_recv().unwrap().is_err());
    assert_eq!(
        state
            .lookup("window-1", &fixture.path())
            .unwrap()
            .unwrap()
            .id,
        latest.id
    );
    assert!(state
        .resolve_owned_path("window-1", &fixture.path(), false)
        .is_err());
}

#[test]
fn save_preserves_requested_and_canonical_aliases_without_broadening_workspace_read() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    #[cfg(not(windows))]
    let alias = fixture.0.join("live/./doc.md");
    #[cfg(windows)]
    let alias = PathBuf::from(fixture.path().strip_prefix(r"\\?\").unwrap());
    let generation = state.generation("main").unwrap();
    let doc = state
        .select("main", generation, vec![alias.clone()], Purpose::Document)
        .unwrap()
        .remove(0);
    let save = state
        .select("main", generation, vec![alias.clone()], Purpose::Save)
        .unwrap()
        .remove(0);
    for spelling in [alias.to_str().unwrap(), &fixture.path()] {
        assert_eq!(state.lookup("main", spelling).unwrap().unwrap().id, doc.id);
        assert_eq!(
            state
                .save_exports
                .get(&("main".into(), spelling.into()))
                .unwrap()
                .id,
            GrantId::parse(&save.id).unwrap()
        );
        assert_eq!(read(&state, "main", spelling), b"original");
    }
    // Selecting a Save path underneath a workspace does not replace its root,
    // nor does it authorize that path for a different window.
    let root = fixture.0.join("live");
    state
        .select(
            "window-1",
            state.generation("window-1").unwrap(),
            vec![root],
            Purpose::Workspace,
        )
        .unwrap();
    fixture.select(&mut state, "window-1", Purpose::Save);
    assert_eq!(read(&state, "window-1", &fixture.path()), b"original");
    assert!(state
        .lookup("main", fixture.0.join("unselected.md").to_str().unwrap())
        .unwrap()
        .is_none());
}
