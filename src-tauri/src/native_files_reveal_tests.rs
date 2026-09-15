use super::*;
use std::{cell::Cell, fs};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("mdw-native-reveal-{}", Uuid::new_v4()));
        fs::create_dir_all(path.join("work/nested")).unwrap();
        fs::write(path.join("work/doc.md"), b"data").unwrap();
        fs::write(path.join("outside.md"), b"outside").unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn path(&self, name: &str) -> String {
        self.0.join(name).to_str().unwrap().into()
    }
    fn state(&self) -> NativeState {
        let mut state = NativeState::default();
        state.register("main").unwrap();
        state.register("window-1").unwrap();
        state
    }
    fn grant(&self, state: &mut NativeState, name: &str, purpose: Purpose) -> NativeGrant {
        state
            .select(
                "main",
                state.generation("main").unwrap(),
                vec![self.path(name).into()],
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

fn denied(state: &NativeState, label: &str, generation: Uuid, path: &str, expected: Option<&str>) {
    let called = Cell::new(false);
    assert!(state
        .reveal_path(label, generation, path, expected, |_| {
            called.set(true);
            Ok(())
        })
        .is_err());
    assert!(!called.get());
}

#[test]
fn reveal_current_owned_read_targets_reach_launcher_once() {
    let f = Fixture::new();
    let mut state = f.state();
    f.grant(&mut state, "work", Purpose::Workspace);
    let generation = state.generation("main").unwrap();
    for name in ["work", "work/nested", "work/doc.md"] {
        let calls = Cell::new(0);
        state
            .reveal_path("main", generation, &f.path(name), None, |path| {
                assert_eq!(path, Path::new(&f.path(name)));
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(calls.get(), 1);
    }
    let resource = f.grant(&mut state, "outside.md", Purpose::Resource);
    state
        .reveal_path(
            "main",
            generation,
            &f.path("outside.md"),
            Some(&resource.id),
            |_| Ok(()),
        )
        .unwrap();
}

#[test]
fn reveal_never_mints_authority_borrows_foreign_grants_or_uses_save_export() {
    let f = Fixture::new();
    let mut state = f.state();
    let generation = state.generation("main").unwrap();
    denied(&state, "main", generation, &f.path("work/doc.md"), None);
    let grant = f.grant(&mut state, "work/doc.md", Purpose::Document);
    denied(
        &state,
        "window-1",
        state.generation("window-1").unwrap(),
        &f.path("work/doc.md"),
        Some(&grant.id),
    );
    denied(&state, "print", generation, &f.path("work/doc.md"), None);
    denied(&state, "main", generation, &f.path("outside.md"), None);
    f.grant(&mut state, "outside.md", Purpose::Save);
    denied(&state, "main", generation, &f.path("outside.md"), None);
}

#[test]
fn reveal_same_path_reselection_and_exact_precedence_reject_stale_expected_ids() {
    let f = Fixture::new();
    let mut state = f.state();
    let workspace = f.grant(&mut state, "work", Purpose::Workspace);
    let exact = f.grant(&mut state, "work/doc.md", Purpose::Resource);
    let generation = state.generation("main").unwrap();
    denied(
        &state,
        "main",
        generation,
        &f.path("work/doc.md"),
        Some(&workspace.id),
    );
    denied(
        &state,
        "main",
        generation,
        &f.path("work/doc.md"),
        Some("invalid-id"),
    );
    let replacement = f.grant(&mut state, "work/doc.md", Purpose::Document);
    denied(
        &state,
        "main",
        generation,
        &f.path("work/doc.md"),
        Some(&exact.id),
    );
    state
        .reveal_path(
            "main",
            generation,
            &f.path("work/doc.md"),
            Some(&replacement.id),
            |_| Ok(()),
        )
        .unwrap();
    let nested = f.grant(&mut state, "work/nested", Purpose::Workspace);
    denied(
        &state,
        "main",
        generation,
        &f.path("work/nested"),
        Some(&workspace.id),
    );
    state
        .reveal_path(
            "main",
            generation,
            &f.path("work/nested"),
            Some(&nested.id),
            |_| Ok(()),
        )
        .unwrap();
}

#[test]
fn reveal_queued_before_revoke_and_label_reuse_cannot_launch() {
    let f = Fixture::new();
    let mut state = f.state();
    f.grant(&mut state, "work", Purpose::Workspace);
    let queued_generation = state.generation("main").unwrap();
    state.revoke("main");
    denied(
        &state,
        "main",
        queued_generation,
        &f.path("work/doc.md"),
        None,
    );
    state.register("main").unwrap();
    f.grant(&mut state, "work", Purpose::Workspace);
    denied(
        &state,
        "main",
        queued_generation,
        &f.path("work/doc.md"),
        None,
    );
}

#[test]
fn reveal_invalid_paths_and_spawn_errors_are_typed_without_fallback() {
    let f = Fixture::new();
    let mut state = f.state();
    f.grant(&mut state, "work", Purpose::Workspace);
    let generation = state.generation("main").unwrap();
    for name in [
        "relative.md",
        "work/../outside.md",
        "work/nested/./x.md",
        "work/nested//x.md",
    ] {
        let path = if name == "relative.md" {
            name.to_owned()
        } else {
            f.path(name)
        };
        denied(&state, "main", generation, &path, None);
    }
    let error = state
        .reveal_path("main", generation, &f.path("work/doc.md"), None, |_| {
            Err(io::Error::other("spawn failed"))
        })
        .unwrap_err();
    let typed = serde_json::to_value(NativeCommandError::from(error)).unwrap();
    assert_eq!(typed["code"], "filesystem_error");
}

#[test]
fn reveal_explorer_converts_only_native_verbatim_prefixes() {
    assert_eq!(
        explorer_path(r"\\?\C:\My Notes\文書.md"),
        r"C:\My Notes\文書.md"
    );
    assert_eq!(
        explorer_path(r"\\?\UNC\server\share\a.md"),
        r"\\server\share\a.md"
    );
    assert_eq!(
        crate::windows_reveal_arg(&explorer_path(r"\\?\C:\")),
        "\"C:\\\""
    );
    assert_eq!(
        crate::windows_reveal_arg(&explorer_path(r"\\?\UNC\server\share\")),
        "\"\\\\server\\share\""
    );
}

#[cfg(unix)]
#[test]
fn reveal_parent_fallback_opens_only_parent_or_root() {
    assert_eq!(
        parent_or_root(Path::new("/notes/doc.md")),
        Path::new("/notes")
    );
    assert_eq!(
        parent_or_root(Path::new("/notes/folder")),
        Path::new("/notes")
    );
    assert_eq!(parent_or_root(Path::new("/")), Path::new("/"));
}
