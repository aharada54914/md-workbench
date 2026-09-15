use super::*;
use crate::file_access::GrantId;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-image-picker-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        for name in ["one.png", "two.JPG", "other.md"] {
            fs::write(root.join(name), name.as_bytes()).unwrap();
        }
        Self(fs::canonicalize(root).unwrap())
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
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

#[test]
fn images_are_ordered_resource_read_grants_owned_by_the_native_caller() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let paths = vec![fixture.path("two.JPG"), fixture.path("one.png")];
    let selected = state
        .select_images("main", state.generation("main").unwrap(), paths.clone())
        .unwrap();
    assert_eq!(selected.len(), 2);
    for (grant, path) in selected.iter().zip(paths) {
        assert_eq!(grant.path, path.to_string_lossy());
        assert_eq!(grant.kind, "resource");
        assert!(grant.read);
        assert!(!grant.write);
        let id = GrantId::parse(&grant.id).unwrap();
        assert_eq!(
            state.access.read("main", id, Path::new(""), 1024).unwrap(),
            fs::read(&path).unwrap()
        );
        assert!(state
            .access
            .read("window-1", id, Path::new(""), 1024)
            .is_err());
        assert!(state.lookup("window-1", &grant.path).unwrap().is_none());
    }
}

#[test]
fn cancel_preserves_existing_selection_and_reselection_issues_a_new_identity() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let generation = state.generation("main").unwrap();
    let path = fixture.path("one.png");
    let first = state
        .select_images("main", generation, vec![path.clone()])
        .unwrap()
        .remove(0);
    assert!(state
        .select_images("main", generation, vec![])
        .unwrap()
        .is_empty());
    assert_eq!(
        state.lookup("main", &first.path).unwrap().unwrap().id,
        first.id
    );
    let second = state
        .select_images("main", generation, vec![path])
        .unwrap()
        .remove(0);
    assert_ne!(first.id, second.id);
    assert_eq!(
        state.lookup("main", &first.path).unwrap().unwrap().id,
        second.id
    );
}

#[test]
fn invalidated_dialog_cannot_grant_to_reused_window_label_even_on_cancel() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let generation = state.generation("main").unwrap();
    state.revoke("main");
    state.register("main").unwrap();
    for paths in [vec![], vec![fixture.path("one.png")]] {
        assert_eq!(
            state.select_images("main", generation, paths).unwrap_err(),
            "permission_required"
        );
    }
    assert!(state.owned.is_empty());
}

#[test]
fn unknown_or_preview_caller_cannot_complete_selection() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    for label in ["renderer", "print-preview", "window-999"] {
        assert_eq!(
            state
                .select_images(label, Uuid::new_v4(), vec![fixture.path("one.png")])
                .unwrap_err(),
            "permission_required"
        );
    }
    assert!(state.owned.is_empty());
}

#[test]
fn excessive_count_or_path_bytes_rejects_before_issuing_any_grants() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let generation = state.generation("main").unwrap();
    for paths in [
        vec![fixture.path("one.png"); MAX_IMAGE_SELECTION + 1],
        vec![
            fixture.path("one.png"),
            PathBuf::from("x".repeat(MAX_IMAGE_SELECTION_PATH_BYTES) + ".png"),
        ],
    ] {
        assert_eq!(
            state.select_images("main", generation, paths).unwrap_err(),
            "selection_limit_exceeded"
        );
        assert!(state.owned.is_empty());
    }
    assert_eq!(
        state
            .select_images(
                "main",
                generation,
                vec![fixture.path("one.png"); MAX_IMAGE_SELECTION]
            )
            .unwrap()
            .len(),
        MAX_IMAGE_SELECTION
    );
}

#[test]
fn disallowed_extension_and_failed_native_selection_preserve_previous_metadata() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let generation = state.generation("main").unwrap();
    let path = fixture.path("one.png");
    let first = state
        .select_images("main", generation, vec![path.clone()])
        .unwrap()
        .remove(0);
    for bad in [fixture.path("other.md"), fixture.path("missing.png")] {
        assert!(state
            .select_images("main", generation, vec![path.clone(), bad])
            .is_err());
        assert_eq!(
            state.lookup("main", &first.path).unwrap().unwrap().id,
            first.id
        );
        assert_eq!(
            state
                .access
                .read(
                    "main",
                    GrantId::parse(&first.id).unwrap(),
                    Path::new(""),
                    1024
                )
                .unwrap(),
            b"one.png"
        );
    }
}

#[test]
fn native_filter_extensions_remain_fixed() {
    assert_eq!(
        IMAGE_EXTENSIONS,
        ["png", "jpg", "jpeg", "gif", "webp", "bmp"]
    );
}
