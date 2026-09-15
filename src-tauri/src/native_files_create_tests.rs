use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("mdw-create-{}", Uuid::new_v4()));
        fs::create_dir_all(path.join("work/nested")).unwrap();
        fs::create_dir(path.join("outside")).unwrap();
        Self(fs::canonicalize(path).unwrap())
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
    fn grant(&self, state: &mut NativeState, relative: &str, rights: Rights) {
        let path = self.path(relative);
        let info = state
            .access
            .grant_directory_from_native_selection(
                "main",
                Path::new(&path),
                GrantKind::Workspace,
                rights,
            )
            .unwrap();
        state.owned.insert(("main".into(), path), info);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn create(
    state: &NativeState,
    label: &str,
    parent: &str,
    name: &str,
    directory: bool,
) -> Result<String, String> {
    state.create_workspace_child(label, state.generation(label)?, parent, name, directory)
}
#[test]
fn unselected_foreign_read_only_revoked_and_previous_generation_are_denied() {
    let f = Fixture::new();
    let mut s = f.state();
    for directory in [false, true] {
        assert_eq!(
            create(&s, "main", &f.path("work"), "new", directory).unwrap_err(),
            "permission_required"
        );
    }
    f.grant(&mut s, "work", Rights::READ);
    assert_eq!(
        create(&s, "main", &f.path("work"), "new", false).unwrap_err(),
        "permission_required"
    );
    f.grant(&mut s, "work", Rights::READ_WRITE);
    assert_eq!(
        create(&s, "window-1", &f.path("work"), "new", true).unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        create(&s, "main", &f.path("outside"), "new", false).unwrap_err(),
        "permission_required"
    );
    let generation = s.generation("main").unwrap();
    let id = s.owned.get(&("main".into(), f.path("work"))).unwrap().id;
    s.access.revoke("main", id);
    assert_eq!(
        create(&s, "main", &f.path("work"), "new", true).unwrap_err(),
        "permission_required"
    );
    s.revoke("main");
    s.register("main").unwrap();
    f.grant(&mut s, "work", Rights::READ_WRITE);
    assert_eq!(
        s.create_workspace_child("main", generation, &f.path("work"), "new", false)
            .unwrap_err(),
        "permission_required"
    );
    assert!(!Path::new(&f.path("work/new.md")).exists());
}
#[test]
fn write_only_grant_works_but_narrow_read_only_or_current_reselection_cannot_fallback() {
    let f = Fixture::new();
    let mut s = f.state();
    f.grant(&mut s, "work", Rights::WRITE);
    create(&s, "main", &f.path("work"), "writeonly", false).unwrap();
    f.grant(&mut s, "work/nested", Rights::READ);
    assert_eq!(
        create(&s, "main", &f.path("work/nested"), "no", false).unwrap_err(),
        "permission_required"
    );
    f.grant(&mut s, "work", Rights::READ);
    assert_eq!(
        create(&s, "main", &f.path("work"), "no", true).unwrap_err(),
        "permission_required"
    );
}
#[test]
fn resource_write_and_export_write_do_not_supply_workspace_authority() {
    let f = Fixture::new();
    let mut s = f.state();
    let info = s
        .access
        .grant_directory_from_native_selection(
            "main",
            Path::new(&f.path("work")),
            GrantKind::Resource,
            Rights::READ_WRITE,
        )
        .unwrap();
    s.owned.insert(("main".into(), f.path("work")), info);
    for directory in [false, true] {
        let error = create(&s, "main", &f.path("work"), "denied", directory).unwrap_err();
        let typed = serde_json::to_value(NativeCommandError::from(error)).unwrap();
        assert_eq!(typed["code"], "permission_required");
    }
    s.select(
        "main",
        s.generation("main").unwrap(),
        vec![f.path("work/save.md").into()],
        Purpose::Save,
    )
    .unwrap();
    assert_eq!(
        create(&s, "main", &f.path("work"), "save", false).unwrap_err(),
        "permission_required"
    );
}

#[test]
fn creates_empty_markdown_and_exclusive_folder_with_compatible_names_and_paths() {
    let f = Fixture::new();
    let mut s = f.state();
    f.grant(&mut s, "work", Rights::READ_WRITE);
    for (name, expected) in [
        ("  Note  ", "Note.md"),
        ("UPPER.MD", "UPPER.MD"),
        ("a.markdown", "a.markdown"),
        ("b.mdx", "b.mdx"),
        ("plain.txt", "plain.txt.md"),
    ] {
        let result = create(&s, "main", &f.path("work/nested"), name, false).unwrap();
        assert_eq!(result, f.path(&format!("work/nested/{expected}")));
        assert_eq!(fs::read(result).unwrap(), b"");
    }
    let folder = create(&s, "main", &f.path("work"), "  New folder  ", true).unwrap();
    assert_eq!(folder, f.path("work/New folder"));
    fs::write(Path::new(&folder).join("keep.md"), b"keep").unwrap();
    assert!(create(&s, "main", &f.path("work"), "New folder", true).is_err());
    assert_eq!(
        fs::read(Path::new(&folder).join("keep.md")).unwrap(),
        b"keep"
    );
    fs::write(f.path("work/existing.md"), b"original").unwrap();
    assert!(create(&s, "main", &f.path("work"), "existing", false).is_err());
    assert!(create(&s, "main", &f.path("work"), "existing.md", true).is_err());
    assert_eq!(fs::read(f.path("work/existing.md")).unwrap(), b"original");
    assert!(create(&s, "main", &f.path("work/missing"), "new", false).is_err());
}
#[test]
fn rejects_portable_name_violations_and_unclean_parent_paths_before_creation() {
    let f = Fixture::new();
    let mut s = f.state();
    f.grant(&mut s, "work", Rights::READ_WRITE);
    for name in [
        "",
        " ",
        ".",
        "..",
        "../escape",
        "a/b",
        "a\\b",
        "a:stream",
        "CON",
        "con.md",
        "COM¹.txt",
        "LPT³",
        "bad.",
        "a?b",
        "a\0b",
    ] {
        for directory in [false, true] {
            assert_eq!(
                create(&s, "main", &f.path("work"), name, directory).unwrap_err(),
                "invalid_path",
                "{name:?}"
            );
        }
    }
    for parent in [
        format!("{}/../outside", f.path("work")),
        format!("{}/./nested", f.path("work")),
        format!("{}//nested", f.path("work")),
    ] {
        assert_eq!(
            create(&s, "main", &parent, "new", true).unwrap_err(),
            "invalid_path"
        );
    }
    assert_eq!(
        create(&s, "main", "relative", "new", false).unwrap_err(),
        "invalid_path"
    );
    assert!(fs::read_dir(f.path("outside")).unwrap().next().is_none());
}
#[cfg(unix)]
#[test]
fn retained_root_substitution_stays_on_original_and_symlink_parents_and_leaves_are_denied() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let mut s = f.state();
    f.grant(&mut s, "work", Rights::READ_WRITE);
    symlink(f.path("outside"), f.path("work/link")).unwrap();
    for directory in [false, true] {
        assert!(create(&s, "main", &f.path("work/link"), "escape", directory).is_err());
    }
    symlink(f.path("outside"), f.path("work/leaf")).unwrap();
    assert!(create(&s, "main", &f.path("work"), "leaf", true).is_err());
    symlink(f.path("outside/secret.md"), f.path("work/leaf.md")).unwrap();
    assert!(create(&s, "main", &f.path("work"), "leaf", false).is_err());
    fs::rename(f.path("work"), f.path("held")).unwrap();
    symlink(f.path("outside"), f.path("work")).unwrap();
    create(&s, "main", &f.path("work/nested"), "retained", false).unwrap();
    create(&s, "main", &f.path("work"), "retained-folder", true).unwrap();
    assert!(Path::new(&f.path("held/nested/retained.md")).is_file());
    assert!(Path::new(&f.path("held/retained-folder")).is_dir());
    assert!(fs::read_dir(f.path("outside")).unwrap().next().is_none());
}
#[cfg(windows)]
#[test]
fn windows_separator_aliases_work_and_junction_parent_is_denied() {
    let f = Fixture::new();
    let mut s = f.state();
    f.grant(&mut s, "work", Rights::READ_WRITE);
    let alias = f.path("work/nested").replace('\\', "/");
    create(&s, "main", &alias, "portable", false).unwrap();
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(f.path("work/junction"))
        .arg(f.path("outside"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "junction fixture required: {output:?}"
    );
    for directory in [false, true] {
        assert!(create(&s, "main", &f.path("work/junction"), "escape", directory).is_err());
    }
    assert!(fs::read_dir(f.path("outside")).unwrap().next().is_none());
}
