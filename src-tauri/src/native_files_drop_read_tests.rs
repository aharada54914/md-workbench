use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-drop-read-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("work")).unwrap();
        fs::write(root.join("work/doc.md"), b"original").unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }
    fn state(&self) -> NativeState {
        let mut state = NativeState::default();
        state.register("main").unwrap();
        state.register("window-1").unwrap();
        state
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn drain_path(state: &mut NativeState, path: PathBuf) -> NativeGrant {
    let generation = state.generation("main").unwrap();
    state
        .enqueue_drop("main", generation, &[path], DropPosition { x: 0.0, y: 0.0 })
        .unwrap();
    state
        .take_drops("main", generation)
        .unwrap()
        .remove(0)
        .grants
        .remove(0)
}
fn select(state: &mut NativeState, owner: &str, path: PathBuf, purpose: Purpose) -> NativeGrant {
    state
        .select(owner, state.generation(owner).unwrap(), vec![path], purpose)
        .unwrap()
        .remove(0)
}
fn read(
    state: &NativeState,
    owner: &str,
    path: &Path,
    expected: Option<&str>,
) -> Result<Vec<u8>, String> {
    state.read_path(
        owner,
        state.generation(owner)?,
        path.to_str().unwrap(),
        100,
        expected,
    )
}
fn tree(
    state: &NativeState,
    owner: &str,
    path: &Path,
    expected: Option<&str>,
) -> Result<serde_json::Value, String> {
    state
        .workspace_tree(
            owner,
            state.generation(owner)?,
            path.to_str().unwrap(),
            10,
            100,
            10000,
            expected,
        )
        .map(|node| serde_json::to_value(node).unwrap())
}

#[test]
fn drop_document_extensions_preserve_existing_editor_support() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    for name in [
        "a.md",
        "a.markdown",
        "a.txt",
        "a.mermark",
        "a.MD",
        "a.TXT",
        "a.MerMark",
    ] {
        let path = fixture.path(name);
        fs::write(&path, b"text").unwrap();
        let grant = drain_path(&mut state, path);
        assert_eq!(grant.kind, "document", "{name}");
        assert!(grant.read && grant.write);
    }
    for name in ["image.png", "a.md.png", "no-extension"] {
        let path = fixture.path(name);
        fs::write(&path, b"bytes").unwrap();
        let grant = drain_path(&mut state, path);
        assert_eq!(grant.kind, "resource", "{name}");
        assert!(grant.read && !grant.write);
    }
}

#[test]
fn drained_document_expected_id_rejects_reselection_and_accepts_current_id() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let path = fixture.path("work/doc.md");
    let old = drain_path(&mut state, path.clone());
    let current = select(&mut state, "main", path.clone(), Purpose::Document);
    assert_ne!(old.id, current.id);
    assert_eq!(
        read(&state, "main", &path, Some(&old.id)),
        Err("permission_required".into())
    );
    assert_eq!(
        read(&state, "main", &path, Some(&current.id)).unwrap(),
        b"original"
    );
    assert_eq!(read(&state, "main", &path, None).unwrap(), b"original");
    assert_eq!(
        read(&state, "main", &path, Some("malformed")),
        Err("permission_required".into())
    );
    let error = NativeCommandError::from("permission_required");
    assert_eq!(
        serde_json::to_value(error).unwrap()["code"],
        "permission_required"
    );
}

#[test]
fn drained_workspace_expected_id_rejects_reselection_and_accepts_current_id() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let path = fixture.path("work");
    let old = drain_path(&mut state, path.clone());
    let current = select(&mut state, "main", path.clone(), Purpose::Workspace);
    assert_eq!(
        tree(&state, "main", &path, Some(&old.id)),
        Err("permission_required".into())
    );
    assert_eq!(
        tree(&state, "main", &path, Some(&current.id)).unwrap()["children"][0]["name"],
        "doc.md"
    );
    assert!(tree(&state, "main", &path, None).is_ok());
    assert_eq!(
        tree(&state, "main", &path, Some("malformed")),
        Err("permission_required".into())
    );
}

#[test]
fn save_export_does_not_change_expected_read_id_or_allow_workspace_fallback() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let directory = fixture.path("work");
    let path = fixture.path("work/doc.md");
    let workspace = drain_path(&mut state, directory.clone());
    select(&mut state, "main", path.clone(), Purpose::Save);
    assert!(tree(&state, "main", &directory, Some(&workspace.id)).is_ok());
    assert_eq!(
        read(&state, "main", &path, Some(&workspace.id)).unwrap(),
        b"original"
    );
    let document = drain_path(&mut state, path.clone());
    select(&mut state, "main", path.clone(), Purpose::Save);
    assert_eq!(
        read(&state, "main", &path, Some(&document.id)).unwrap(),
        b"original"
    );
    // A valid historical workspace UUID cannot override exact-document precedence.
    assert_eq!(
        read(&state, "main", &path, Some(&workspace.id)),
        Err("permission_required".into())
    );
}

#[test]
fn expected_id_is_bound_to_actual_caller_and_generation() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let path = fixture.path("work/doc.md");
    let directory = fixture.path("work");
    let document = drain_path(&mut state, path.clone());
    let workspace = drain_path(&mut state, directory.clone());
    let other_doc = select(&mut state, "window-1", path.clone(), Purpose::Document);
    let other_workspace = select(
        &mut state,
        "window-1",
        directory.clone(),
        Purpose::Workspace,
    );
    assert_eq!(
        read(&state, "window-1", &path, Some(&document.id)),
        Err("permission_required".into())
    );
    assert_eq!(
        tree(&state, "window-1", &directory, Some(&workspace.id)),
        Err("permission_required".into())
    );
    assert!(read(&state, "window-1", &path, Some(&other_doc.id)).is_ok());
    assert!(tree(&state, "window-1", &directory, Some(&other_workspace.id)).is_ok());
    assert_eq!(
        read(&state, "preview", &path, Some(&document.id)),
        Err("permission_required".into())
    );
    let old_generation = state.generation("main").unwrap();
    state.revoke("main");
    state.register("main").unwrap();
    let replacement = select(&mut state, "main", path.clone(), Purpose::Document);
    assert_eq!(
        state.read_path(
            "main",
            old_generation,
            path.to_str().unwrap(),
            100,
            Some(&replacement.id)
        ),
        Err("permission_required".into())
    );
    assert_eq!(
        read(&state, "main", &path, Some(&document.id)),
        Err("permission_required".into())
    );
}

#[cfg(unix)]
#[test]
fn drained_grants_cannot_follow_a_reselected_parent_replacement() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let directory = fixture.path("work");
    let path = directory.join("doc.md");
    let document = drain_path(&mut state, path.clone());
    let workspace = drain_path(&mut state, directory.clone());
    fs::rename(&directory, fixture.path("retained-old")).unwrap();
    fs::create_dir(&directory).unwrap();
    fs::write(&path, b"replacement").unwrap();
    fs::write(directory.join("new.md"), b"new").unwrap();
    // Before reselection both operations retain the original native anchor.
    assert_eq!(
        read(&state, "main", &path, Some(&document.id)).unwrap(),
        b"original"
    );
    assert_eq!(
        tree(&state, "main", &directory, Some(&workspace.id)).unwrap()["children"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let new_document = select(&mut state, "main", path.clone(), Purpose::Document);
    let new_workspace = select(&mut state, "main", directory.clone(), Purpose::Workspace);
    assert_eq!(
        read(&state, "main", &path, Some(&document.id)),
        Err("permission_required".into())
    );
    assert_eq!(
        tree(&state, "main", &directory, Some(&workspace.id)),
        Err("permission_required".into())
    );
    assert_eq!(
        read(&state, "main", &path, Some(&new_document.id)).unwrap(),
        b"replacement"
    );
    assert_eq!(
        tree(&state, "main", &directory, Some(&new_workspace.id)).unwrap()["children"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
