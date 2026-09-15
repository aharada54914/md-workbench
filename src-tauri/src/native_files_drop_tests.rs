use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-native-drop-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("work")).unwrap();
        fs::write(root.join("work/doc.md"), b"original").unwrap();
        fs::write(root.join("image.png"), b"image").unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }
    fn state(&self) -> NativeState {
        let mut state = NativeState::default();
        for owner in ["main", "window-1"] {
            state.register(owner).unwrap();
        }
        state
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn position() -> DropPosition {
    DropPosition { x: 12.5, y: 240.0 }
}
fn enqueue(state: &mut NativeState, owner: &str, paths: &[PathBuf]) -> Result<bool, String> {
    state.enqueue_drop(owner, state.generation(owner)?, paths, position())
}
fn take(state: &mut NativeState, owner: &str) -> Result<Vec<NativeDrop>, String> {
    state.take_drops(owner, state.generation(owner)?)
}
fn select(state: &mut NativeState, owner: &str, path: PathBuf, purpose: Purpose) -> NativeGrant {
    state
        .select(owner, state.generation(owner).unwrap(), vec![path], purpose)
        .unwrap()
        .remove(0)
}

#[test]
fn native_drop_is_ready_before_listener_and_drains_once_with_partial_results_and_position() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let missing = fixture.path("missing.md");
    enqueue(
        &mut state,
        "main",
        &[
            fixture.path("work/doc.md"),
            missing.clone(),
            fixture.path("image.png"),
            fixture.path("work"),
        ],
    )
    .unwrap();
    // No listener registration is required to retain a completed native event.
    let first = take(&mut state, "main").unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0].grants.iter().map(|g| g.kind).collect::<Vec<_>>(),
        ["document", "resource", "workspace"]
    );
    assert_eq!(first[0].errors.len(), 1);
    assert_eq!(first[0].errors[0].path, missing.to_string_lossy());
    assert!(first[0].grants[0].read && first[0].grants[0].write);
    assert!(first[0].grants[1].read && !first[0].grants[1].write);
    assert!(first[0].grants[2].read && first[0].grants[2].write);
    let json = serde_json::to_value(&first[0]).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 4);
    assert_eq!(json["position"], serde_json::json!({"x":12.5,"y":240.0}));
    assert!(Uuid::parse_str(json["id"].as_str().unwrap()).is_ok());
    assert_eq!(json["errors"][0].as_object().unwrap().len(), 2);
    assert!(take(&mut state, "main").unwrap().is_empty());
}

#[test]
fn pending_drops_are_ordered_window_owned_and_never_granted_by_take_or_lookup() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let path = fixture.path("work/doc.md");
    assert!(take(&mut state, "main").unwrap().is_empty());
    assert!(state
        .lookup("main", path.to_str().unwrap())
        .unwrap()
        .is_none());
    for forbidden in ["preview", "print-preview", "window-print", "unknown"] {
        assert!(state
            .enqueue_drop(forbidden, Uuid::new_v4(), &[path.clone()], position())
            .is_err());
        assert!(state.take_drops(forbidden, Uuid::new_v4()).is_err());
        assert!(!state.allows_custom_ipc(forbidden, forbidden));
    }
    enqueue(&mut state, "main", &[path.clone()]).unwrap();
    enqueue(&mut state, "main", &[fixture.path("image.png")]).unwrap();
    assert!(take(&mut state, "window-1").unwrap().is_empty());
    assert!(state
        .lookup("window-1", path.to_str().unwrap())
        .unwrap()
        .is_none());
    let pending = take(&mut state, "main").unwrap();
    assert_eq!(pending.len(), 2);
    assert_ne!(pending[0].id, pending[1].id);
    assert_eq!(pending[0].grants[0].kind, "document");
    assert_eq!(pending[1].grants[0].kind, "resource");
    assert!(!state.allows_custom_ipc("child", "main"));
    assert!(!state.allows_custom_ipc("main", "window-1"));
}

#[test]
fn destroyed_reused_and_stale_generations_cannot_take_or_issue_old_drops() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let old = state.generation("main").unwrap();
    enqueue(&mut state, "main", &[fixture.path("work/doc.md")]).unwrap();
    state.revoke("main");
    assert!(!state.drops.contains_key("main"));
    state.register("main").unwrap();
    assert!(take(&mut state, "main").unwrap().is_empty());
    enqueue(&mut state, "main", &[fixture.path("image.png")]).unwrap();
    assert!(state.take_drops("main", old).is_err());
    assert!(state
        .enqueue_drop("main", old, &[fixture.path("work/doc.md")], position())
        .is_err());
    assert_eq!(
        take(&mut state, "main").unwrap()[0].grants[0].kind,
        "resource"
    );
    // Defense if generation changes while lifecycle cleanup was missed.
    enqueue(&mut state, "main", &[fixture.path("work/doc.md")]).unwrap();
    state.windows.insert("main".into(), Uuid::new_v4());
    assert!(take(&mut state, "main").unwrap().is_empty());
}

#[test]
fn queue_capacity_rejects_before_grant_creation_without_discarding_older_drops() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    for n in 0..MAX_PENDING_DROPS {
        let path = fixture.path(&format!("{n}.md"));
        fs::write(&path, b"queued").unwrap();
        enqueue(&mut state, "main", &[path]).unwrap();
    }
    let protected = fixture.path("work/doc.md");
    let old = select(&mut state, "main", protected.clone(), Purpose::Resource);
    let metadata_count = state.owned.len();
    assert_eq!(
        enqueue(&mut state, "main", &[protected.clone()]).unwrap_err(),
        "drop_queue_full"
    );
    assert_eq!(state.owned.len(), metadata_count);
    assert_eq!(
        state
            .lookup("main", protected.to_str().unwrap())
            .unwrap()
            .unwrap()
            .id,
        old.id
    );
    assert!(
        !state
            .lookup("main", protected.to_str().unwrap())
            .unwrap()
            .unwrap()
            .write
    );
    assert_eq!(take(&mut state, "main").unwrap().len(), MAX_PENDING_DROPS);
    // Bounds are per window, not a global queue that blocks another editor.
    enqueue(&mut state, "window-1", &[protected]).unwrap();
    assert_eq!(take(&mut state, "window-1").unwrap().len(), 1);
}

#[test]
fn path_count_and_utf8_byte_bounds_reject_before_any_grants_or_queue_mutation() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    enqueue(&mut state, "main", &[fixture.path("image.png")]).unwrap();
    let before = state.owned.len();
    assert_eq!(
        enqueue(
            &mut state,
            "main",
            &vec![fixture.path("work/doc.md"); MAX_DROP_PATHS + 1]
        )
        .unwrap_err(),
        "drop_too_large"
    );
    // Non-ASCII input verifies bytes are counted, not Unicode scalar values.
    let huge = PathBuf::from("界".repeat(MAX_DROP_PATH_BYTES / 3 + 1));
    assert_eq!(
        enqueue(&mut state, "main", &[huge]).unwrap_err(),
        "drop_too_large"
    );
    assert_eq!(state.owned.len(), before);
    assert!(state
        .lookup("main", fixture.path("work/doc.md").to_str().unwrap())
        .unwrap()
        .is_none());
    assert_eq!(take(&mut state, "main").unwrap().len(), 1);
    assert!(!enqueue(&mut state, "main", &[]).unwrap());
    assert!(take(&mut state, "main").unwrap().is_empty());
    // Exact byte and count limits are accepted; invalid paths become partial errors.
    enqueue(
        &mut state,
        "main",
        &[PathBuf::from("a".repeat(MAX_DROP_PATH_BYTES))],
    )
    .unwrap();
    assert_eq!(take(&mut state, "main").unwrap()[0].errors.len(), 1);
    enqueue(
        &mut state,
        "main",
        &vec![fixture.path("missing.md"); MAX_DROP_PATHS],
    )
    .unwrap();
    assert_eq!(
        take(&mut state, "main").unwrap()[0].errors.len(),
        MAX_DROP_PATHS
    );
}

#[test]
fn newer_non_save_selection_turns_stale_drop_into_failure_while_save_keeps_it_valid() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let path = fixture.path("work/doc.md");
    enqueue(&mut state, "main", &[path.clone()]).unwrap();
    let newer = select(&mut state, "main", path.clone(), Purpose::Resource);
    let stale = take(&mut state, "main").unwrap();
    assert!(stale[0].grants.is_empty());
    assert_eq!(stale[0].errors[0].error, "drop_grant_changed");
    assert_eq!(
        state
            .lookup("main", path.to_str().unwrap())
            .unwrap()
            .unwrap()
            .id,
        newer.id
    );
    enqueue(&mut state, "main", &[path.clone()]).unwrap();
    let current = state
        .lookup("main", path.to_str().unwrap())
        .unwrap()
        .unwrap();
    select(&mut state, "main", path, Purpose::Save);
    let valid = take(&mut state, "main").unwrap();
    assert_eq!(valid[0].grants[0].id, current.id);
    assert!(valid[0].errors.is_empty());
}

#[cfg(unix)]
#[test]
fn queued_drop_never_switches_to_a_reselected_parent_at_the_same_path() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let path = fixture.path("work/doc.md");
    enqueue(&mut state, "main", &[path.clone()]).unwrap();
    fs::rename(fixture.path("work"), fixture.path("moved")).unwrap();
    fs::create_dir(fixture.path("work")).unwrap();
    fs::write(&path, b"replacement").unwrap();
    let newer = select(&mut state, "main", path.clone(), Purpose::Document);
    let dropped = take(&mut state, "main").unwrap();
    assert!(dropped[0].grants.is_empty());
    assert_eq!(dropped[0].errors[0].error, "drop_grant_changed");
    assert_eq!(
        state
            .lookup("main", path.to_str().unwrap())
            .unwrap()
            .unwrap()
            .id,
        newer.id
    );
    assert_eq!(
        state
            .access
            .read(
                "main",
                GrantId::parse(&newer.id).unwrap(),
                Path::new(""),
                100
            )
            .unwrap(),
        b"replacement"
    );
}

#[test]
fn repeated_same_path_drops_fail_the_superseded_item_without_reviving_its_id() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let path = fixture.path("work/doc.md");
    enqueue(&mut state, "main", &[path.clone()]).unwrap();
    let old = state
        .lookup("main", path.to_str().unwrap())
        .unwrap()
        .unwrap();
    enqueue(&mut state, "main", &[path.clone()]).unwrap();
    let current = state
        .lookup("main", path.to_str().unwrap())
        .unwrap()
        .unwrap();
    let drops = take(&mut state, "main").unwrap();
    assert_eq!(drops.len(), 2);
    assert!(drops[0].grants.is_empty());
    assert_eq!(drops[0].errors[0].error, "drop_grant_changed");
    assert_eq!(drops[1].grants[0].id, current.id);
    assert_ne!(old.id, current.id);
    assert_eq!(
        state
            .lookup("main", path.to_str().unwrap())
            .unwrap()
            .unwrap()
            .id,
        current.id
    );
}

#[test]
fn revoked_core_grant_cannot_be_returned_even_if_metadata_is_still_present() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let path = fixture.path("work/doc.md");
    enqueue(&mut state, "main", &[path.clone()]).unwrap();
    let grant = state
        .lookup("main", path.to_str().unwrap())
        .unwrap()
        .unwrap();
    state
        .access
        .revoke("main", GrantId::parse(&grant.id).unwrap());
    let drops = take(&mut state, "main").unwrap();
    assert!(drops[0].grants.is_empty());
    assert_eq!(drops[0].errors[0].error, "drop_grant_changed");
}
