use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-native-image-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("work/sub/images")).unwrap();
        fs::write(root.join("work/sub/doc.md"), b"doc").unwrap();
        fs::write(root.join("work/sub/images/a.png"), b"\0\xffimage").unwrap();
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
    fn grant(&self, state: &mut NativeState, path: &str, purpose: Purpose) -> String {
        state
            .select(
                "main",
                state.generation("main").unwrap(),
                vec![self.path(path).into()],
                purpose,
            )
            .unwrap()[0]
            .id
            .clone()
    }
    fn descriptor(&self, state: &NativeState, label: &str) -> Result<ImageDocument, String> {
        state.image_document(
            label,
            state.generation(label)?,
            &self.path("work/sub/doc.md"),
        )
    }
    fn read(&self, state: &NativeState, label: &str, id: &str) -> Result<Vec<u8>, String> {
        state.read_image(
            label,
            state.generation(label)?,
            &self.path("work/sub/doc.md"),
            id,
            "images/a.png",
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn image_commands_never_create_authority_and_isolate_callers() {
    let f = Fixture::new();
    let mut state = f.state();
    let fake = Uuid::new_v4().to_string();
    assert_eq!(
        f.descriptor(&state, "main").unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        f.read(&state, "main", &fake).unwrap_err(),
        "permission_required"
    );
    assert!(state.owned.is_empty());
    let id = f.grant(&mut state, "work/sub/doc.md", Purpose::Document);
    assert_eq!(
        serde_json::to_value(f.descriptor(&state, "main").unwrap()).unwrap(),
        serde_json::json!({ "grantId": id })
    );
    let count = state.owned.len();
    assert_eq!(f.read(&state, "main", &id).unwrap(), b"\0\xffimage");
    assert_eq!(state.owned.len(), count);
    for label in ["window-1", "print-preview", "unknown"] {
        assert_eq!(
            f.descriptor(&state, label).unwrap_err(),
            "permission_required"
        );
        assert_eq!(
            f.read(&state, label, &id).unwrap_err(),
            "permission_required"
        );
    }
    for expected in ["", "invalid", &fake] {
        assert_eq!(
            f.read(&state, "main", expected).unwrap_err(),
            "permission_required"
        );
    }
    assert_eq!(
        state
            .image_document("main", state.generation("main").unwrap(), "doc.md")
            .unwrap_err(),
        "invalid_path"
    );
}

#[test]
fn image_commands_require_current_identity_and_generation() {
    let f = Fixture::new();
    let mut state = f.state();
    let old = f.grant(&mut state, "work/sub/doc.md", Purpose::Document);
    let new = f.grant(&mut state, "work/sub/doc.md", Purpose::Document);
    assert_ne!(old, new);
    assert_eq!(
        f.read(&state, "main", &old).unwrap_err(),
        "permission_required"
    );
    assert_eq!(f.descriptor(&state, "main").unwrap().grant_id, new);
    assert!(f.read(&state, "main", &new).is_ok());
    let old_generation = state.generation("main").unwrap();
    state.revoke("main");
    state.register("main").unwrap();
    let id = f.grant(&mut state, "work/sub/doc.md", Purpose::Document);
    assert_eq!(
        state
            .image_document("main", old_generation, &f.path("work/sub/doc.md"))
            .unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        state
            .read_image(
                "main",
                old_generation,
                &f.path("work/sub/doc.md"),
                &id,
                "images/a.png"
            )
            .unwrap_err(),
        "permission_required"
    );
    assert!(f.read(&state, "main", &id).is_ok());
}

#[test]
fn image_document_workspace_resolution_keeps_exact_and_longest_precedence() {
    let f = Fixture::new();
    let mut state = f.state();
    let broad = f.grant(&mut state, "work", Purpose::Workspace);
    assert_eq!(f.descriptor(&state, "main").unwrap().grant_id, broad);
    assert!(f.read(&state, "main", &broad).is_ok());
    let narrow = f.grant(&mut state, "work/sub", Purpose::Workspace);
    assert_eq!(f.descriptor(&state, "main").unwrap().grant_id, narrow);
    assert_eq!(
        f.read(&state, "main", &broad).unwrap_err(),
        "permission_required"
    );
    let exact = f.grant(&mut state, "work/sub/doc.md", Purpose::Document);
    assert_eq!(f.descriptor(&state, "main").unwrap().grant_id, exact);
    assert_eq!(
        f.read(&state, "main", &narrow).unwrap_err(),
        "permission_required"
    );
    let resource = f.grant(&mut state, "work/sub/doc.md", Purpose::Resource);
    assert_eq!(
        f.descriptor(&state, "main").unwrap_err(),
        "invalid_grant_kind"
    );
    assert_eq!(
        f.read(&state, "main", &resource).unwrap_err(),
        "invalid_grant_kind"
    );
    assert_eq!(
        f.read(&state, "main", &exact).unwrap_err(),
        "permission_required"
    );
}

#[test]
fn save_export_does_not_pose_as_document_or_disturb_document_read() {
    let f = Fixture::new();
    let mut state = f.state();
    let export = f.grant(&mut state, "work/sub/doc.md", Purpose::Save);
    assert_eq!(
        f.descriptor(&state, "main").unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        f.read(&state, "main", &export).unwrap_err(),
        "permission_required"
    );
    let doc = f.grant(&mut state, "work/sub/doc.md", Purpose::Document);
    f.grant(&mut state, "work/sub/doc.md", Purpose::Save);
    assert_eq!(f.descriptor(&state, "main").unwrap().grant_id, doc);
    assert!(f.read(&state, "main", &doc).is_ok());
}

#[test]
fn descriptor_and_read_both_validate_current_document_type() {
    let f = Fixture::new();
    let mut state = f.state();
    let id = f.grant(&mut state, "work/sub/doc.md", Purpose::Document);
    fs::remove_file(f.path("work/sub/doc.md")).unwrap();
    assert_eq!(f.descriptor(&state, "main").unwrap_err(), "file_not_found");
    assert_eq!(f.read(&state, "main", &id).unwrap_err(), "file_not_found");
    fs::create_dir(f.path("work/sub/doc.md")).unwrap();
    assert_eq!(f.descriptor(&state, "main").unwrap_err(), "invalid_path");
    assert_eq!(f.read(&state, "main", &id).unwrap_err(), "invalid_path");
}
