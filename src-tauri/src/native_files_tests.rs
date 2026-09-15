use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("mdw-native-{}", Uuid::new_v4()));
        fs::create_dir_all(path.join("workspace")).unwrap();
        fs::write(path.join("doc.md"), b"original").unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn registered() -> NativeState {
    let mut state = NativeState::default();
    state.register("main").unwrap();
    state
}

#[test]
fn renderer_lookup_cannot_create_authority_or_cross_windows() {
    let fixture = Fixture::new();
    let mut state = registered();
    let path = fixture.path("doc.md");
    let path_string = path.to_str().unwrap();
    assert!(state.lookup("main", path_string).unwrap().is_none());
    assert!(state.lookup("preview", path_string).is_err());
    let generation = state.generation("main").unwrap();
    let selected = state
        .select("main", generation, vec![path], Purpose::Document)
        .unwrap();
    assert!(selected[0].read && selected[0].write);
    state.register("window-1").unwrap();
    assert!(state
        .lookup("window-1", &selected[0].path)
        .unwrap()
        .is_none());
    assert_eq!(
        state.lookup("main", &selected[0].path).unwrap().unwrap().id,
        selected[0].id
    );
}

#[test]
fn cancelled_selection_and_failed_batch_do_not_change_grants() {
    let fixture = Fixture::new();
    let mut state = registered();
    let generation = state.generation("main").unwrap();
    assert!(state
        .select("main", generation, Vec::new(), Purpose::Document)
        .unwrap()
        .is_empty());
    assert!(state.owned.is_empty());
    assert!(state
        .select(
            "main",
            generation,
            vec![fixture.path("doc.md"), fixture.path("missing.md")],
            Purpose::Document
        )
        .is_err());
    assert!(state.owned.is_empty());
    assert!(state
        .lookup("main", fixture.path("doc.md").to_str().unwrap())
        .unwrap()
        .is_none());
}

#[test]
fn callback_from_destroyed_window_cannot_reissue_a_grant() {
    let fixture = Fixture::new();
    let mut state = registered();
    let generation = state.generation("main").unwrap();
    state.revoke("main");
    assert!(state
        .select(
            "main",
            generation,
            vec![fixture.path("doc.md")],
            Purpose::Document
        )
        .is_err());
    state.register("main").unwrap();
    assert_ne!(state.generation("main").unwrap(), generation);
    assert!(state
        .select(
            "main",
            generation,
            vec![fixture.path("doc.md")],
            Purpose::Document
        )
        .is_err());
    assert!(state.owned.is_empty());
}

#[test]
fn picker_purposes_fix_the_scope_and_rights() {
    let fixture = Fixture::new();
    let mut state = registered();
    let generation = state.generation("main").unwrap();
    let resource = state
        .select(
            "main",
            generation,
            vec![fixture.path("doc.md")],
            Purpose::Resource,
        )
        .unwrap();
    assert_eq!(resource[0].kind, "resource");
    assert!(resource[0].read && !resource[0].write);
    let export = state
        .select(
            "main",
            generation,
            vec![fixture.path("new.md")],
            Purpose::Save,
        )
        .unwrap();
    assert_eq!(export[0].kind, "export");
    assert!(!export[0].read && export[0].write);
    assert!(!fixture.path("new.md").exists());
    let workspace = state
        .select(
            "main",
            generation,
            vec![fixture.path("workspace")],
            Purpose::Workspace,
        )
        .unwrap();
    assert_eq!(workspace[0].kind, "workspace");
    assert!(workspace[0].read && workspace[0].write);
}

#[test]
fn native_ingress_survives_no_window_and_reassigns_after_owner_destruction() {
    let fixture = Fixture::new();
    let path = fixture.path("doc.md").to_str().unwrap().to_owned();
    let mut state = NativeState::default();
    assert!(state.capture(std::slice::from_ref(&path)).is_empty());
    assert!(state.distribute("main").is_err());
    state.register("main").unwrap();
    state.distribute("main").unwrap();
    let old = state.lookup("main", &path).unwrap().unwrap();
    state.revoke("main");
    assert!(state.lookup("main", &path).is_err());
    state.register("window-1").unwrap();
    state.distribute("window-1").unwrap();
    let new = state.lookup("window-1", &path).unwrap().unwrap();
    assert_ne!(old.id, new.id);
    let id = crate::file_access::GrantId::parse(&new.id).unwrap();
    assert_eq!(
        state
            .access
            .read("window-1", id, Path::new(""), 100)
            .unwrap(),
        b"original"
    );
    state.delivered(std::slice::from_ref(&path));
    assert!(state.pending.is_empty());
    assert!(state.lookup("window-1", &path).unwrap().is_some());
}

#[test]
fn repeated_distribution_is_idempotent_and_missing_ingress_never_grants() {
    let fixture = Fixture::new();
    let path = fixture.path("doc.md").to_str().unwrap().to_owned();
    let missing = fixture.path("missing.md").to_str().unwrap().to_owned();
    let mut state = registered();
    let errors = state.capture(&[path.clone(), missing.clone()]);
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].path, missing);
    assert_eq!(state.distribute("main").unwrap().len(), 1);
    assert!(state.distribute("main").unwrap().is_empty());
    assert!(state.lookup("main", &missing).unwrap().is_none());
}

#[cfg(unix)]
#[test]
fn reassigning_pending_ingress_uses_pinned_anchor_not_replaced_parent_path() {
    let fixture = Fixture::new();
    let path = fixture.path("workspace/doc.md");
    fs::write(&path, b"selected").unwrap();
    fs::create_dir(fixture.path("outside")).unwrap();
    fs::write(fixture.path("outside/doc.md"), b"outside").unwrap();
    let path_string = path.to_str().unwrap().to_owned();
    let mut state = registered();
    assert!(state.capture(std::slice::from_ref(&path_string)).is_empty());
    state.distribute("main").unwrap();
    state.revoke("main");
    fs::rename(fixture.path("workspace"), fixture.path("moved")).unwrap();
    std::os::unix::fs::symlink(fixture.path("outside"), fixture.path("workspace")).unwrap();
    state.register("window-1").unwrap();
    state.distribute("window-1").unwrap();
    let grant = state.lookup("window-1", &path_string).unwrap().unwrap();
    let id = crate::file_access::GrantId::parse(&grant.id).unwrap();
    assert_eq!(
        state
            .access
            .read("window-1", id, Path::new(""), 100)
            .unwrap(),
        b"selected"
    );
}

#[test]
fn os_document_ingress_does_not_reuse_a_previous_resource_grant() {
    let fixture = Fixture::new();
    let mut state = registered();
    let path = fixture.path("doc.md");
    let generation = state.generation("main").unwrap();
    let resource = state
        .select("main", generation, vec![path.clone()], Purpose::Resource)
        .unwrap();
    let requested = path.to_str().unwrap().to_owned();
    state.capture(std::slice::from_ref(&requested));
    state.distribute("main").unwrap();
    let document = state.lookup("main", &requested).unwrap().unwrap();
    assert_ne!(resource[0].id, document.id);
    assert_eq!(document.kind, "document");
    assert!(document.read && document.write);
    state.delivered(std::slice::from_ref(&requested));
    state.capture(std::slice::from_ref(&requested));
    assert_eq!(state.distribute("main").unwrap().len(), 1);
}

#[test]
fn ipc_metadata_and_errors_use_the_documented_shape() {
    let fixture = Fixture::new();
    let mut state = registered();
    let generation = state.generation("main").unwrap();
    let grants = state
        .select(
            "main",
            generation,
            vec![fixture.path("doc.md")],
            Purpose::Document,
        )
        .unwrap();
    let json = serde_json::to_value(&grants[0]).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 5);
    assert_eq!(json["kind"], "document");
    assert_eq!(json["read"], true);
    assert_eq!(json["write"], true);
    let error = serde_json::to_value(NativeCommandError::from("permission_required")).unwrap();
    assert_eq!(
        error,
        serde_json::json!({"code":"permission_required","message":"permission_required"})
    );
    let io_error = serde_json::to_value(NativeCommandError::from("filesystem: gone")).unwrap();
    assert_eq!(io_error["code"], "filesystem_error");
    for code in ["already_exists", "unsupported_operation"] {
        let error = serde_json::to_value(NativeCommandError::from(code)).unwrap();
        assert_eq!(error["code"], code);
    }
}

#[test]
fn custom_ipc_only_accepts_the_host_registered_editor_webview() {
    let mut state = registered();
    assert!(state.allows_custom_ipc("main", "main"));
    for (webview, window) in [
        ("print-preview", "print-preview"),
        ("window-print", "window-print"),
        ("unknown", "unknown"),
        ("window-1", "window-1"),
        ("child", "main"),
        ("main", "window-1"),
    ] {
        assert!(!state.allows_custom_ipc(webview, window));
    }
    assert!(state.register("print-preview").is_err());
    state.register("window-1").unwrap();
    assert!(state.allows_custom_ipc("window-1", "window-1"));
    assert!(!state.allows_custom_ipc("main", "window-1"));
    state.revoke("main");
    assert!(!state.allows_custom_ipc("main", "main"));
}
