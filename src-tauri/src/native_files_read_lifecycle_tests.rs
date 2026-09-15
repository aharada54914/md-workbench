use super::*;
use crate::file_access::AccessError;
use std::{fs, io};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-read-lifecycle-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("doc.md"), b"original").unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn path(&self) -> String {
        self.0.join("doc.md").to_str().unwrap().into()
    }
    fn state(&self) -> NativeState {
        let mut state = NativeState::default();
        state.register("main").unwrap();
        state.register("window-1").unwrap();
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

fn read(state: &NativeState, label: &str, path: &str) -> Result<Vec<u8>, String> {
    state.read_path(label, state.generation(label)?, path, 100)
}
fn code(error: String) -> String {
    serde_json::to_value(NativeCommandError::from(error)).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn authorized_deleted_leaf_has_stable_code_without_an_unowned_existence_oracle() {
    let fixture = Fixture::new();
    let state = fixture.state();
    fs::remove_file(fixture.path()).unwrap();
    assert_eq!(
        code(read(&state, "main", &fixture.path()).unwrap_err()),
        "file_not_found"
    );
    assert_eq!(
        code(read(&state, "window-1", &fixture.path()).unwrap_err()),
        "permission_required"
    );
    let missing = fixture.0.join("never-selected.md");
    assert_eq!(
        code(read(&state, "main", missing.to_str().unwrap()).unwrap_err()),
        "permission_required"
    );
}

#[test]
fn retained_document_grant_reads_atomic_leaf_replacement_and_recreation_exactly() {
    let fixture = Fixture::new();
    let state = fixture.state();
    let before = state.lookup("main", &fixture.path()).unwrap().unwrap().id;
    let replacement = b"\xef\xbb\xbf# New\r\nraw \r\n";
    let temporary = fixture.0.join("replacement.tmp");
    fs::write(&temporary, replacement).unwrap();
    fs::rename(&temporary, fixture.path()).unwrap();
    assert_eq!(read(&state, "main", &fixture.path()).unwrap(), replacement);
    fs::remove_file(fixture.path()).unwrap();
    assert_eq!(
        code(read(&state, "main", &fixture.path()).unwrap_err()),
        "file_not_found"
    );
    fs::write(fixture.path(), b"recreated\r\n").unwrap();
    assert_eq!(
        read(&state, "main", &fixture.path()).unwrap(),
        b"recreated\r\n"
    );
    assert_eq!(
        state.lookup("main", &fixture.path()).unwrap().unwrap().id,
        before
    );
}

#[test]
fn only_os_not_found_is_reported_as_file_not_found() {
    assert_eq!(
        code(AccessError::from(io::Error::from(io::ErrorKind::NotFound)).to_string()),
        "file_not_found"
    );
    for kind in [
        io::ErrorKind::PermissionDenied,
        io::ErrorKind::Interrupted,
        io::ErrorKind::InvalidData,
        io::ErrorKind::Other,
    ] {
        assert_eq!(
            code(AccessError::from(io::Error::new(kind, "file_not_found")).to_string()),
            "filesystem_error"
        );
    }
    assert_eq!(code(AccessError::Denied.to_string()), "permission_required");
    assert_eq!(code(AccessError::TooLarge.to_string()), "file_too_large");
    let fixture = Fixture::new();
    let state = fixture.state();
    fs::remove_file(fixture.path()).unwrap();
    fs::create_dir(fixture.path()).unwrap();
    assert_ne!(
        code(read(&state, "main", &fixture.path()).unwrap_err()),
        "file_not_found"
    );
}
