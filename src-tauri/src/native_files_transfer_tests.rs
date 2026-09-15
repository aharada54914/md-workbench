use super::*;
use std::fs;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("mdw-transfer-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("doc.md"), b"original").unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn document(&self) -> PathBuf {
        self.0.join("doc.md")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn state_with_file(fixture: &Fixture, purpose: Purpose) -> NativeState {
    let mut state = NativeState::default();
    state.register("main").unwrap();
    state.register("window-1").unwrap();
    state
        .select(
            "main",
            state.generation("main").unwrap(),
            vec![fixture.document()],
            purpose,
        )
        .unwrap();
    state
}

#[test]
fn transfer_copies_only_callers_exact_readable_authority_and_preserves_source() {
    let fixture = Fixture::new();
    let mut state = state_with_file(&fixture, Purpose::Resource);
    let path = fixture.document();
    let path = path.to_str().unwrap();
    assert!(state.copy_file("window-1", "main", path).is_err());
    assert!(state.copy_file("main", "window-2", path).is_err());
    assert!(state
        .copy_file("main", "window-1", "/unselected.md")
        .is_err());
    let original = state.lookup("main", path).unwrap().unwrap();
    state.copy_file("main", "window-1", path).unwrap();
    let copied = state.lookup("window-1", path).unwrap().unwrap();
    assert_ne!(original.id, copied.id);
    assert!(copied.read);
    assert!(!copied.write);
    assert_eq!(state.lookup("main", path).unwrap().unwrap().id, original.id);
    state.revoke("main");
    assert_eq!(
        state
            .access
            .read(
                "window-1",
                GrantId::parse(&copied.id).unwrap(),
                Path::new(""),
                100
            )
            .unwrap(),
        b"original"
    );
}
#[test]
fn directory_and_write_only_authority_cannot_transfer_as_a_tab() {
    let fixture = Fixture::new();
    let mut state = state_with_file(&fixture, Purpose::Save);
    let path = fixture.document();
    assert!(state
        .copy_file("main", "window-1", path.to_str().unwrap())
        .is_err());
    state
        .select(
            "main",
            state.generation("main").unwrap(),
            vec![fixture.0.clone()],
            Purpose::Workspace,
        )
        .unwrap();
    assert!(state
        .copy_file("main", "window-1", fixture.0.to_str().unwrap())
        .is_err());
}
#[test]
fn failed_delivery_rollback_restores_existing_target_and_retains_source() {
    let fixture = Fixture::new();
    let mut state = state_with_file(&fixture, Purpose::Document);
    let path = fixture.document();
    let path = path.to_str().unwrap();
    state
        .select(
            "window-1",
            state.generation("window-1").unwrap(),
            vec![PathBuf::from(path)],
            Purpose::Resource,
        )
        .unwrap();
    let old = state.lookup("window-1", path).unwrap().unwrap();
    let copy = state.copy_file("main", "window-1", path).unwrap();
    let id = copy.id;
    state.rollback_copy(copy);
    assert_eq!(state.lookup("window-1", path).unwrap().unwrap().id, old.id);
    assert!(state
        .access
        .read("window-1", id, Path::new(""), 100)
        .is_err());
    assert!(state.lookup("main", path).unwrap().is_some());
}
#[test]
fn delayed_rollback_does_not_erase_newer_selection_or_reused_target() {
    let fixture = Fixture::new();
    let mut state = state_with_file(&fixture, Purpose::Document);
    let path = fixture.document();
    let path = path.to_str().unwrap();
    let copy = state.copy_file("main", "window-1", path).unwrap();
    state
        .select(
            "window-1",
            state.generation("window-1").unwrap(),
            vec![PathBuf::from(path)],
            Purpose::Resource,
        )
        .unwrap();
    let fresh = state.lookup("window-1", path).unwrap().unwrap();
    state.rollback_copy(copy);
    assert_eq!(
        state.lookup("window-1", path).unwrap().unwrap().id,
        fresh.id
    );
    let copy = state.copy_file("main", "window-1", path).unwrap();
    state.revoke("window-1");
    state.register("window-1").unwrap();
    state.rollback_copy(copy);
    assert!(state.lookup("window-1", path).unwrap().is_none());
}
#[test]
fn blank_window_reservation_never_authorizes_ipc_and_destroy_prevents_activation() {
    let mut state = NativeState::default();
    state.reserve_editor("window-1").unwrap();
    assert!(!state.allows_custom_ipc("window-1", "window-1"));
    assert!(state.reserve_editor("window-1").is_err());
    state.revoke("window-1");
    assert!(state.activate_editor("window-1").is_err());
    state.reserve_editor("window-2").unwrap();
    state.activate_editor("window-2").unwrap();
    assert!(state.allows_custom_ipc("window-2", "window-2"));
    assert!(state.reserve_editor("window-2").is_err());
}
#[cfg(unix)]
#[test]
fn transfer_keeps_the_original_parent_handle_after_path_replacement() {
    let fixture = Fixture::new();
    let mut state = state_with_file(&fixture, Purpose::Document);
    let path = fixture.document().to_str().unwrap().to_owned();
    let moved = fixture.0.with_extension("moved");
    fs::rename(&fixture.0, &moved).unwrap();
    fs::create_dir(&fixture.0).unwrap();
    fs::write(fixture.document(), b"replacement").unwrap();
    state.copy_file("main", "window-1", &path).unwrap();
    let copy = state.lookup("window-1", &path).unwrap().unwrap();
    assert_eq!(
        state
            .access
            .read(
                "window-1",
                GrantId::parse(&copy.id).unwrap(),
                Path::new(""),
                100
            )
            .unwrap(),
        b"original"
    );
    fs::remove_dir_all(moved).unwrap();
}

#[test]
fn overlapping_failed_copies_do_not_restore_a_revoked_metadata_alias() {
    let fixture = Fixture::new();
    let mut state = state_with_file(&fixture, Purpose::Document);
    let path = fixture.document();
    let path = path.to_str().unwrap();
    let first = state.copy_file("main", "window-1", path).unwrap();
    let second = state.copy_file("main", "window-1", path).unwrap();
    state.rollback_copy(first);
    state.rollback_copy(second);
    assert!(state.lookup("window-1", path).unwrap().is_none());
    assert!(state.lookup("main", path).unwrap().is_some());
}
