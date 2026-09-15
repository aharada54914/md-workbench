use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-watch-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("work")).unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        fs::write(root.join("work/doc.md"), b"original").unwrap();
        fs::write(root.join("outside/doc.md"), b"outside sentinel").unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn path(&self, relative: &str) -> String {
        self.0.join(relative).to_str().unwrap().into()
    }
    fn state(&self) -> NativeState {
        let mut state = NativeState::default();
        state.register("main").unwrap();
        state.register("window-1").unwrap();
        state
    }
    fn grant(&self, state: &mut NativeState, relative: &str, purpose: Purpose) -> String {
        state
            .select(
                "main",
                state.generation("main").unwrap(),
                vec![self.path(relative).into()],
                purpose,
            )
            .unwrap()[0]
            .id
            .clone()
    }
    fn subscribe(&self, state: &mut NativeState, grant: &str) -> Result<NativeWatch, String> {
        state.subscribe_watch(
            "main",
            state.generation("main")?,
            &self.path("work/doc.md"),
            grant,
        )
    }
    fn selected(&self) -> (NativeState, NativeWatch) {
        let mut state = self.state();
        let grant = self.grant(&mut state, "work/doc.md", Purpose::Document);
        let watch = self.subscribe(&mut state, &grant).unwrap();
        (state, watch)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn read(state: &mut NativeState, label: &str, id: &str, limit: usize) -> Result<Vec<u8>, String> {
    let generation = state.generation(label)?;
    let id = Uuid::parse_str(id).unwrap();
    state.begin_watch_read(label, generation, id, limit)?;
    state.read_watch(label, generation, id, limit)
}

#[test]
fn watch_requires_current_read_document_authority_not_renderer_paths_or_exports() {
    let f = Fixture::new();
    let mut state = f.state();
    let fake = Uuid::new_v4().to_string();
    assert_eq!(
        f.subscribe(&mut state, &fake).unwrap_err(),
        "permission_required"
    );
    let export = f.grant(&mut state, "work/doc.md", Purpose::Save);
    assert_eq!(
        f.subscribe(&mut state, &export).unwrap_err(),
        "permission_required"
    );
    let workspace = f.grant(&mut state, "work", Purpose::Workspace);
    let watch = f.subscribe(&mut state, &workspace).unwrap();
    assert_eq!(watch.grant_id, workspace);
    assert_eq!(
        read(&mut state, "main", &watch.id, 100).unwrap(),
        b"original"
    );
    let resource = f.grant(&mut state, "work/doc.md", Purpose::Resource);
    assert_eq!(
        f.subscribe(&mut state, &resource).unwrap_err(),
        "invalid_grant_kind"
    );
    let doc = f.grant(&mut state, "work/doc.md", Purpose::Document);
    for invalid in ["", "bad", &fake, &workspace] {
        assert_eq!(
            f.subscribe(&mut state, invalid).unwrap_err(),
            "permission_required"
        );
    }
    assert!(f.subscribe(&mut state, &doc).is_ok());
    assert_eq!(
        state
            .subscribe_watch(
                "main",
                state.generation("main").unwrap(),
                &f.path("outside/doc.md"),
                &doc
            )
            .unwrap_err(),
        "permission_required"
    );
}

#[test]
fn watch_read_and_teardown_isolate_owners_and_generations() {
    let f = Fixture::new();
    let (mut state, watch) = f.selected();
    let id = Uuid::parse_str(&watch.id).unwrap();
    let generation = state.generation("main").unwrap();
    for label in ["window-1", "print-preview", "unknown"] {
        assert_eq!(
            read(&mut state, label, &watch.id, 100).unwrap_err(),
            "permission_required"
        );
    }
    state
        .unsubscribe_watch("window-1", state.generation("window-1").unwrap(), id)
        .unwrap();
    assert!(state.watches.contains_key(&id));
    state.begin_watch_read("main", generation, id, 100).unwrap();
    state.revoke("main");
    assert!(state.watches.is_empty());
    state.register("main").unwrap();
    let grant = f.grant(&mut state, "work/doc.md", Purpose::Document);
    assert_eq!(
        state.read_watch("main", generation, id, 100).unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        state
            .subscribe_watch("main", generation, &f.path("work/doc.md"), &grant)
            .unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        state.unsubscribe_watch("main", generation, id).unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        read(&mut state, "main", &watch.id, 100).unwrap_err(),
        "permission_required"
    );
}

#[test]
fn watch_reselection_and_core_revocation_are_terminal_even_for_queued_reads() {
    let f = Fixture::new();
    let (mut state, watch) = f.selected();
    let id = Uuid::parse_str(&watch.id).unwrap();
    let generation = state.generation("main").unwrap();
    state.begin_watch_read("main", generation, id, 100).unwrap();
    let replacement = f.grant(&mut state, "work/doc.md", Purpose::Document);
    assert_eq!(
        state.read_watch("main", generation, id, 100).unwrap_err(),
        "permission_required"
    );
    assert!(!state.watches.contains_key(&id));
    let watch = f.subscribe(&mut state, &replacement).unwrap();
    state
        .access
        .revoke("main", GrantId::parse(&replacement).unwrap());
    assert_eq!(
        read(&mut state, "main", &watch.id, 100).unwrap_err(),
        "permission_required"
    );
    assert!(state.watches.is_empty());
}

#[test]
fn watch_inflight_is_bounded_and_unsubscribe_cancels_queued_work_idempotently() {
    let f = Fixture::new();
    let (mut state, watch) = f.selected();
    let id = Uuid::parse_str(&watch.id).unwrap();
    let generation = state.generation("main").unwrap();
    assert_eq!(
        state.read_watch("main", generation, id, 100).unwrap_err(),
        "permission_required"
    );
    state.begin_watch_read("main", generation, id, 100).unwrap();
    assert_eq!(
        state
            .begin_watch_read("main", generation, id, 100)
            .unwrap_err(),
        "watch_busy"
    );
    assert_eq!(
        state.read_watch("main", generation, id, 100).unwrap(),
        b"original"
    );
    state.begin_watch_read("main", generation, id, 100).unwrap();
    state.unsubscribe_watch("main", generation, id).unwrap();
    state.unsubscribe_watch("main", generation, id).unwrap();
    state
        .unsubscribe_watch("main", generation, Uuid::new_v4())
        .unwrap();
    assert_eq!(
        state.read_watch("main", generation, id, 100).unwrap_err(),
        "permission_required"
    );
    assert!(state.watches.is_empty());
}

#[test]
fn watch_quotas_count_stored_alias_and_relative_bytes_without_partial_registration() {
    let f = Fixture::new();
    let mut state = f.state();
    let grant = f.grant(&mut state, "work", Purpose::Workspace);
    let generation = state.generation("main").unwrap();
    let path = f.path("work/doc.md");
    let bytes = path.len() + "doc.md".len();
    assert_eq!(
        state
            .subscribe_watch_bounded("main", generation, &path, &grant, 2, bytes - 1)
            .unwrap_err(),
        "watch_limit_exceeded"
    );
    assert!(state.watches.is_empty());
    state
        .subscribe_watch_bounded("main", generation, &path, &grant, 2, bytes)
        .unwrap();
    assert_eq!(
        state
            .subscribe_watch_bounded("main", generation, &path, &grant, 2, bytes * 2 - 1)
            .unwrap_err(),
        "watch_limit_exceeded"
    );
    state
        .subscribe_watch_bounded("main", generation, &path, &grant, 2, bytes * 2)
        .unwrap();
    assert_eq!(
        state
            .subscribe_watch_bounded("main", generation, &path, &grant, 2, bytes * 3)
            .unwrap_err(),
        "watch_limit_exceeded"
    );
    assert_eq!(state.watches.len(), 2);
    state.revoke("main");
    assert!(state.watches.is_empty());
}

#[test]
fn watch_reads_replacement_deletion_and_recreation_without_accepting_initial_content() {
    let f = Fixture::new();
    let (mut state, watch) = f.selected();
    // An edit in the subscribe-to-first-poll gap must be returned immediately.
    let raw = b"\xef\xbb\xbf# Japanese \xe6\x97\xa5\r\n\xc3\x28";
    fs::write(f.path("work/replacement.tmp"), raw).unwrap();
    fs::rename(f.path("work/replacement.tmp"), f.path("work/doc.md")).unwrap();
    assert_eq!(read(&mut state, "main", &watch.id, 100).unwrap(), raw);
    fs::remove_file(f.path("work/doc.md")).unwrap();
    assert_eq!(
        read(&mut state, "main", &watch.id, 100).unwrap_err(),
        "file_not_found"
    );
    assert_eq!(state.watches.len(), 1);
    fs::write(f.path("work/doc.md"), b"recreated").unwrap();
    assert_eq!(
        read(&mut state, "main", &watch.id, 100).unwrap(),
        b"recreated"
    );
}

#[test]
fn watch_size_and_type_errors_are_distinct_from_deletion_and_do_not_stick_busy() {
    let f = Fixture::new();
    let (mut state, watch) = f.selected();
    for limit in [0, MAX_WATCH_READ_BYTES + 1, 7] {
        assert_eq!(
            read(&mut state, "main", &watch.id, limit).unwrap_err(),
            "file_too_large"
        );
    }
    assert_eq!(read(&mut state, "main", &watch.id, 8).unwrap(), b"original");
    fs::remove_file(f.path("work/doc.md")).unwrap();
    assert_eq!(
        f.subscribe(&mut state, &watch.grant_id).unwrap_err(),
        "file_not_found"
    );
    fs::create_dir(f.path("work/doc.md")).unwrap();
    assert_eq!(
        read(&mut state, "main", &watch.id, 100).unwrap_err(),
        "invalid_path"
    );
    assert_eq!(
        f.subscribe(&mut state, &watch.grant_id).unwrap_err(),
        "invalid_path"
    );
    fs::remove_dir(f.path("work/doc.md")).unwrap();
    fs::write(f.path("work/doc.md"), b"restored").unwrap();
    assert_eq!(
        read(&mut state, "main", &watch.id, 100).unwrap(),
        b"restored"
    );
}

#[test]
fn watch_typed_errors_and_dto_are_stable() {
    for code in [
        "watch_busy",
        "watch_limit_exceeded",
        "permission_required",
        "file_not_found",
        "file_too_large",
    ] {
        assert_eq!(
            serde_json::to_value(NativeCommandError::from(code)).unwrap()["code"],
            code
        );
    }
    assert_eq!(
        serde_json::to_value(parse_watch_id("malformed").unwrap_err()).unwrap()["code"],
        "permission_required"
    );
    let f = Fixture::new();
    let (_, watch) = f.selected();
    assert_eq!(
        serde_json::to_value(&watch).unwrap(),
        serde_json::json!({"id": watch.id, "grantId": watch.grant_id})
    );
}

#[cfg(unix)]
#[test]
fn watch_keeps_retained_parent_and_rejects_link_substitution() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let (mut state, watch) = f.selected();
    fs::rename(f.path("work"), f.path("held")).unwrap();
    symlink(f.path("outside"), f.path("work")).unwrap();
    assert_eq!(
        read(&mut state, "main", &watch.id, 100).unwrap(),
        b"original"
    );
    fs::remove_file(f.path("held/doc.md")).unwrap();
    symlink(f.path("outside/doc.md"), f.path("held/doc.md")).unwrap();
    assert_eq!(
        read(&mut state, "main", &watch.id, 100).unwrap_err(),
        "invalid_path"
    );
    assert_eq!(
        fs::read(f.path("outside/doc.md")).unwrap(),
        b"outside sentinel"
    );
}

#[cfg(windows)]
#[test]
fn watch_rejects_windows_junction_substitution_with_existing_outside_leaf() {
    let f = Fixture::new();
    let mut state = f.state();
    fs::create_dir(f.path("work/nested")).unwrap();
    fs::write(f.path("work/nested/doc.md"), b"nested").unwrap();
    let grant = f.grant(&mut state, "work", Purpose::Workspace);
    let watch = state
        .subscribe_watch(
            "main",
            state.generation("main").unwrap(),
            &f.path("work/nested/doc.md"),
            &grant,
        )
        .unwrap();
    fs::rename(f.path("work/nested"), f.path("work/held")).unwrap();
    assert!(std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(f.path("work/nested"))
        .arg(f.path("outside"))
        .output()
        .unwrap()
        .status
        .success());
    assert!(read(&mut state, "main", &watch.id, 100).is_err());
    assert_eq!(
        fs::read(f.path("outside/doc.md")).unwrap(),
        b"outside sentinel"
    );
}
