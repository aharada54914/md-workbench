use super::*;
use crate::file_access::{AccessError, Rights};
use std::fs;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-native-mutate-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("work/nested")).unwrap();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("work/source.md"), b"source").unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn path(&self, path: &str) -> String {
        self.0.join(path).to_str().unwrap().into()
    }
    fn state(&self) -> NativeState {
        let mut state = NativeState::default();
        state.register("main").unwrap();
        state.register("window-1").unwrap();
        state
    }
    fn grant(&self, state: &mut NativeState, path: &str, kind: GrantKind, rights: Rights) {
        let alias = self.path(path);
        let info = state
            .access
            .grant_directory_from_native_selection("main", Path::new(&alias), kind, rights)
            .unwrap();
        state.owned.insert(("main".into(), alias), info);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn rename(s: &NativeState, label: &str, from: &str, to: &str) -> Result<(), NativeCommandError> {
    s.rename_workspace_path(label, s.generation(label)?, from, to)
}
fn delete(s: &NativeState, label: &str, path: &str) -> Result<(), NativeDeleteError> {
    s.delete_workspace_path(label, s.generation(label)?, path)
}
fn code(error: impl serde::Serialize) -> String {
    serde_json::to_value(error).unwrap()["code"]
        .as_str()
        .unwrap()
        .into()
}
#[test]
fn ungranted_foreign_print_and_unknown_callers_cannot_rename_delete_or_noop() {
    let f = Fixture::new();
    let mut s = f.state();
    let source = f.path("work/source.md");
    let target = f.path("target/new.md");
    assert_eq!(
        code(rename(&s, "main", &source, &source).unwrap_err()),
        "permission_required"
    );
    assert_eq!(
        code(delete(&s, "main", &source).unwrap_err()),
        "permission_required"
    );
    f.grant(&mut s, "work", GrantKind::Workspace, Rights::READ_WRITE);
    f.grant(&mut s, "target", GrantKind::Workspace, Rights::READ_WRITE);
    for label in ["window-1", "print-preview", "unknown"] {
        assert_eq!(
            code(rename(&s, label, &source, &target).unwrap_err()),
            "permission_required"
        );
        let failure = delete(&s, label, &source).unwrap_err();
        assert!(!failure.partial);
        assert_eq!(failure.removed, 0);
        assert_eq!(code(failure), "permission_required");
    }
    assert!(Path::new(&source).exists());
}
#[test]
fn generation_reuse_and_revocation_do_not_reauthorize_scheduled_mutations() {
    let f = Fixture::new();
    let mut s = f.state();
    f.grant(&mut s, "work", GrantKind::Workspace, Rights::READ_WRITE);
    let old = s.generation("main").unwrap();
    s.revoke("main");
    s.register("main").unwrap();
    f.grant(&mut s, "work", GrantKind::Workspace, Rights::READ_WRITE);
    assert_eq!(
        code(
            s.rename_workspace_path(
                "main",
                old,
                &f.path("work/source.md"),
                &f.path("work/new.md")
            )
            .unwrap_err()
        ),
        "permission_required"
    );
    assert_eq!(
        code(
            s.delete_workspace_path("main", old, &f.path("work/source.md"))
                .unwrap_err()
        ),
        "permission_required"
    );
    let id = s.owned.get(&("main".into(), f.path("work"))).unwrap().id;
    s.access.revoke("main", id);
    assert_eq!(
        code(delete(&s, "main", &f.path("work/source.md")).unwrap_err()),
        "permission_required"
    );
    assert!(Path::new(&f.path("work/source.md")).exists());
}
#[test]
fn both_endpoints_need_current_workspace_write_and_narrower_read_cannot_fallback() {
    let f = Fixture::new();
    let mut s = f.state();
    let source = f.path("work/source.md");
    let target = f.path("target/new.md");
    f.grant(&mut s, "work", GrantKind::Workspace, Rights::READ_WRITE);
    assert_eq!(
        code(rename(&s, "main", &source, &target).unwrap_err()),
        "permission_required"
    );
    for kind in [GrantKind::Resource, GrantKind::Workspace] {
        f.grant(
            &mut s,
            "target",
            kind,
            if kind == GrantKind::Resource {
                Rights::WRITE
            } else {
                Rights::READ
            },
        );
        assert_eq!(
            code(rename(&s, "main", &source, &target).unwrap_err()),
            "permission_required"
        );
    }
    f.grant(&mut s, "work/nested", GrantKind::Workspace, Rights::READ);
    assert_eq!(
        code(rename(&s, "main", &source, &f.path("work/nested/no.md")).unwrap_err()),
        "permission_required"
    );
    f.grant(&mut s, "work", GrantKind::Workspace, Rights::READ);
    assert_eq!(
        code(delete(&s, "main", &source).unwrap_err()),
        "permission_required"
    );
    f.grant(&mut s, "work", GrantKind::Workspace, Rights::WRITE);
    f.grant(&mut s, "target", GrantKind::Workspace, Rights::WRITE);
    rename(&s, "main", &source, &target).unwrap();
    delete(&s, "main", &target).unwrap();
}
#[test]
fn roots_and_invalid_endpoint_names_are_rejected_before_io() {
    let f = Fixture::new();
    let mut s = f.state();
    f.grant(&mut s, "work", GrantKind::Workspace, Rights::READ_WRITE);
    let source = f.path("work/source.md");
    for path in [
        f.path("work"),
        // PathBuf::join normalizes dots for Windows verbatim prefixes. Keep
        // renderer input literal so this tests rejection before native I/O.
        format!("{}/../outside", f.path("work")),
        f.path("work/CON"),
        f.path("work/a:ads"),
        format!("{}/./new.md", f.path("work")),
    ] {
        assert_eq!(
            code(rename(&s, "main", &source, &path).unwrap_err()),
            "invalid_path"
        );
        assert_eq!(
            code(rename(&s, "main", &path, &source).unwrap_err()),
            "invalid_path"
        );
        let failure = delete(&s, "main", &path).unwrap_err();
        assert!(!failure.partial);
        assert_eq!(code(failure), "invalid_path");
    }
    assert!(Path::new(&source).exists());
}
#[test]
fn rename_collision_and_delete_failure_dtos_preserve_stable_code_and_partial_evidence() {
    let f = Fixture::new();
    let mut s = f.state();
    f.grant(&mut s, "work", GrantKind::Workspace, Rights::READ_WRITE);
    fs::write(f.path("work/existing.md"), b"keep").unwrap();
    assert_eq!(
        code(
            rename(
                &s,
                "main",
                &f.path("work/source.md"),
                &f.path("work/existing.md")
            )
            .unwrap_err()
        ),
        "already_exists"
    );
    let failure = NativeDeleteError::from(DeleteFailure {
        error: AccessError::TooLarge,
        partial: true,
        removed: 7,
    });
    let dto = serde_json::to_value(failure).unwrap();
    assert_eq!(dto["code"], "file_too_large");
    assert_eq!(dto["partial"], true);
    assert_eq!(dto["removed"], 7);
    let failure = delete(&s, "main", &f.path("work/missing.md")).unwrap_err();
    assert!(!failure.partial);
    assert_eq!(code(failure), "file_not_found");
}
