use super::*;
use std::fs;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-mutation-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("work/tree/nested")).unwrap();
        fs::create_dir(root.join("target")).unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        fs::write(root.join("work/source.md"), b"\xef\xbb\xbf# Raw\r\n").unwrap();
        fs::write(root.join("work/tree/a.md"), b"a").unwrap();
        fs::write(root.join("work/tree/nested/b.md"), b"b").unwrap();
        fs::write(root.join("outside/sentinel.md"), b"outside").unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn access(&self) -> (FileAccess, GrantInfo, GrantInfo) {
        let mut access = FileAccess::default();
        access.register_window("main").unwrap();
        access.register_window("window-1").unwrap();
        let source = self.grant(
            &mut access,
            "work",
            GrantKind::Workspace,
            Rights::READ_WRITE,
        );
        let target = self.grant(
            &mut access,
            "target",
            GrantKind::Workspace,
            Rights::READ_WRITE,
        );
        (access, source, target)
    }
    fn grant(
        &self,
        access: &mut FileAccess,
        path: &str,
        kind: GrantKind,
        rights: Rights,
    ) -> GrantInfo {
        access
            .grant_directory_from_native_selection("main", &self.0.join(path), kind, rights)
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn both_mutations_require_workspace_write_owned_live_grants_and_nonroot_clean_paths() {
    let f = Fixture::new();
    let (mut a, s, t) = f.access();
    let readonly = f.grant(&mut a, "target", GrantKind::Workspace, Rights::READ);
    let resource = f.grant(&mut a, "target", GrantKind::Resource, Rights::WRITE);
    for id in [readonly.id, resource.id] {
        assert!(a
            .rename_no_replace(
                "main",
                s.id,
                Path::new("source.md"),
                id,
                Path::new("new.md")
            )
            .is_err());
        assert!(a
            .rename_no_replace("main", id, Path::new("new.md"), s.id, Path::new("new.md"))
            .is_err());
        let failure = a.delete_tree("main", id, Path::new("new.md")).unwrap_err();
        assert!(!failure.partial);
        assert_eq!(failure.removed, 0);
    }
    for bad in [
        "",
        "../outside",
        "a/../b",
        "a/./b",
        "a//b",
        "/absolute",
        "a:stream",
        "CON",
        "LPT².txt",
        "a\\b",
    ] {
        assert!(
            a.rename_no_replace("main", s.id, Path::new(bad), t.id, Path::new("new.md"))
                .is_err(),
            "{bad}"
        );
        assert!(
            a.rename_no_replace("main", s.id, Path::new("source.md"), t.id, Path::new(bad))
                .is_err(),
            "{bad}"
        );
        assert!(
            !a.delete_tree("main", s.id, Path::new(bad))
                .unwrap_err()
                .partial
        );
    }
    assert!(a
        .rename_no_replace(
            "window-1",
            s.id,
            Path::new("source.md"),
            t.id,
            Path::new("new.md")
        )
        .is_err());
    assert!(a
        .delete_tree("window-1", s.id, Path::new("source.md"))
        .is_err());
    a.revoke("main", s.id);
    assert!(a
        .rename_no_replace(
            "main",
            s.id,
            Path::new("source.md"),
            t.id,
            Path::new("new.md")
        )
        .is_err());
    assert!(a.delete_tree("main", s.id, Path::new("source.md")).is_err());
    assert!(f.0.join("work/source.md").exists());
}
#[test]
fn rename_preserves_bytes_moves_directories_across_parents_and_authorizes_noop() {
    let f = Fixture::new();
    let (a, s, t) = f.access();
    a.rename_no_replace(
        "main",
        s.id,
        Path::new("source.md"),
        s.id,
        Path::new("source.md"),
    )
    .unwrap();
    a.rename_no_replace(
        "main",
        s.id,
        Path::new("source.md"),
        t.id,
        Path::new("moved.md"),
    )
    .unwrap();
    assert_eq!(
        fs::read(f.0.join("target/moved.md")).unwrap(),
        b"\xef\xbb\xbf# Raw\r\n"
    );
    a.rename_no_replace(
        "main",
        s.id,
        Path::new("tree"),
        t.id,
        Path::new("moved-tree"),
    )
    .unwrap();
    assert_eq!(
        fs::read(f.0.join("target/moved-tree/nested/b.md")).unwrap(),
        b"b"
    );
    assert!(!f.0.join("work/tree").exists());
    assert!(a
        .rename_no_replace(
            "window-1",
            t.id,
            Path::new("moved.md"),
            t.id,
            Path::new("moved.md")
        )
        .is_err());
}
#[test]
fn rename_never_replaces_existing_file_directory_or_destination_created_at_publication() {
    let f = Fixture::new();
    let (a, s, t) = f.access();
    fs::write(f.0.join("target/existing.md"), b"keep").unwrap();
    fs::create_dir(f.0.join("target/existing-dir")).unwrap();
    for to in ["existing.md", "existing-dir"] {
        let error = a
            .rename_no_replace("main", s.id, Path::new("source.md"), t.id, Path::new(to))
            .unwrap_err();
        assert_eq!(mutation_error_message(&error), "already_exists");
    }
    let (source, source_name) = a
        .workspace_parent("main", s.id, Path::new("source.md"))
        .unwrap();
    let (target, target_name) = a
        .workspace_parent("main", t.id, Path::new("raced.md"))
        .unwrap();
    // Destination appears after authorization/parent capture, immediately before
    // the actual primitive. There is no exists-check in the production path.
    fs::write(f.0.join("target/raced.md"), b"race winner").unwrap();
    assert_eq!(
        rename_leaf_no_replace(&source, &source_name, &target, &target_name)
            .unwrap_err()
            .kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(
        fs::read(f.0.join("target/raced.md")).unwrap(),
        b"race winner"
    );
    assert_eq!(fs::read(f.0.join("target/existing.md")).unwrap(), b"keep");
    assert!(f.0.join("work/source.md").exists());
}
#[test]
fn delete_walk_removes_all_entries_and_accepts_exact_count_and_depth_limits() {
    let f = Fixture::new();
    let (a, s, _) = f.access();
    // tree + a + nested + b = 4 visited entries; b is depth 2.
    a.delete_tree_with(
        "main",
        s.id,
        Path::new("tree"),
        DeleteLimits {
            entries: 4,
            depth: 2,
        },
        &mut |_, _, _| Ok(()),
    )
    .unwrap();
    assert!(!f.0.join("work/tree").exists());
    assert_eq!(
        fs::read(f.0.join("outside/sentinel.md")).unwrap(),
        b"outside"
    );
}
#[test]
fn delete_budget_and_depth_failures_report_partial_work_instead_of_success() {
    for limits in [
        DeleteLimits {
            entries: 0,
            depth: 50,
        },
        DeleteLimits {
            entries: 2,
            depth: 50,
        },
        DeleteLimits {
            entries: 100,
            depth: 0,
        },
    ] {
        let f = Fixture::new();
        let (a, s, _) = f.access();
        let error = a
            .delete_tree_with("main", s.id, Path::new("tree"), limits, &mut |_, _, _| {
                Ok(())
            })
            .unwrap_err();
        assert!(matches!(error.error, AccessError::TooLarge));
        if limits.entries == 0 || limits.depth == 0 {
            assert!(!error.partial);
        }
        assert!(f.0.join("work/tree").is_dir());
    }
}
#[test]
fn delete_injected_failure_after_a_confirmed_removal_is_explicitly_partial() {
    let f = Fixture::new();
    let (a, s, _) = f.access();
    let mut calls = 0;
    let failure = a
        .delete_tree_with(
            "main",
            s.id,
            Path::new("tree"),
            DeleteLimits::default(),
            &mut |stage, _, _| {
                if stage == DeleteStage::BeforeRemove {
                    calls += 1;
                    if calls == 2 {
                        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected"));
                    }
                }
                Ok(())
            },
        )
        .unwrap_err();
    assert!(failure.partial);
    assert_eq!(failure.removed, 1);
    assert!(
        matches!(failure.error, AccessError::Io(error) if error.kind() == io::ErrorKind::PermissionDenied)
    );
    assert!(f.0.join("work/tree").is_dir());
}
#[cfg(unix)]
#[test]
fn final_and_nested_links_are_unlinked_without_touching_outside_and_specials_fail_closed() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let (a, s, t) = f.access();
    symlink(f.0.join("outside"), f.0.join("work/tree/link")).unwrap();
    symlink(f.0.join("missing"), f.0.join("work/tree/dangling")).unwrap();
    symlink(f.0.join("missing"), f.0.join("target/dangling")).unwrap();
    assert_eq!(
        mutation_error_message(
            &a.rename_no_replace(
                "main",
                s.id,
                Path::new("source.md"),
                t.id,
                Path::new("dangling")
            )
            .unwrap_err()
        ),
        "already_exists"
    );
    a.delete_tree("main", s.id, Path::new("tree")).unwrap();
    assert_eq!(
        fs::read(f.0.join("outside/sentinel.md")).unwrap(),
        b"outside"
    );
    assert!(std::process::Command::new("mkfifo")
        .arg(f.0.join("work/socket"))
        .status()
        .unwrap()
        .success());
    let error = a
        .delete_tree("main", s.id, Path::new("socket"))
        .unwrap_err();
    assert!(!error.partial);
    assert_eq!(
        mutation_error_message(&error.error),
        "unsupported_operation"
    );
    fs::write(f.0.join("work/CON"), b"unsupported name").unwrap();
    assert!(a.delete_tree("main", s.id, Path::new("CON")).is_err());
}
#[cfg(unix)]
#[test]
fn parent_symlinks_deny_mutations_and_replaced_native_root_uses_retained_identity() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let (a, s, t) = f.access();
    symlink(f.0.join("outside"), f.0.join("work/link")).unwrap();
    assert!(a
        .rename_no_replace(
            "main",
            s.id,
            Path::new("link/sentinel.md"),
            t.id,
            Path::new("steal.md")
        )
        .is_err());
    assert!(a
        .rename_no_replace(
            "main",
            s.id,
            Path::new("source.md"),
            s.id,
            Path::new("link/new.md")
        )
        .is_err());
    assert!(a
        .delete_tree("main", s.id, Path::new("link/sentinel.md"))
        .is_err());
    fs::rename(f.0.join("work"), f.0.join("held")).unwrap();
    symlink(f.0.join("outside"), f.0.join("work")).unwrap();
    a.rename_no_replace(
        "main",
        s.id,
        Path::new("source.md"),
        s.id,
        Path::new("renamed.md"),
    )
    .unwrap();
    a.delete_tree("main", s.id, Path::new("tree")).unwrap();
    assert!(f.0.join("held/renamed.md").exists());
    assert_eq!(
        fs::read(f.0.join("outside/sentinel.md")).unwrap(),
        b"outside"
    );
}
#[cfg(unix)]
#[test]
fn directory_replacement_after_open_never_recurses_into_replacement_link() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let (a, s, _) = f.access();
    let mut replaced = false;
    let failure = a
        .delete_tree_with(
            "main",
            s.id,
            Path::new("tree"),
            DeleteLimits::default(),
            &mut |stage, _, name| {
                if stage == DeleteStage::AfterOpen && name == "tree" && !replaced {
                    fs::rename(f.0.join("work/tree"), f.0.join("held-tree"))?;
                    symlink(f.0.join("outside"), f.0.join("work/tree"))?;
                    replaced = true;
                }
                Ok(())
            },
        )
        .unwrap_err();
    assert!(failure.partial);
    assert!(failure.removed > 0);
    assert_eq!(
        fs::read(f.0.join("outside/sentinel.md")).unwrap(),
        b"outside"
    );
    assert!(fs::read_dir(f.0.join("held-tree"))
        .unwrap()
        .next()
        .is_none());
}
#[cfg(unix)]
#[test]
fn directory_replaced_before_inspection_is_only_unlinked_and_final_rmdir_race_cannot_recurse() {
    use std::os::unix::fs::symlink;
    for stage_to_replace in [DeleteStage::BeforeInspect, DeleteStage::BeforeRemove] {
        let f = Fixture::new();
        let (a, s, _) = f.access();
        let mut replaced = false;
        let result = a.delete_tree_with(
            "main",
            s.id,
            Path::new("tree"),
            DeleteLimits::default(),
            &mut |stage, _, name| {
                if stage == stage_to_replace && name == "tree" && !replaced {
                    fs::rename(f.0.join("work/tree"), f.0.join("held-tree"))?;
                    symlink(f.0.join("outside"), f.0.join("work/tree"))?;
                    replaced = true;
                }
                Ok(())
            },
        );
        if stage_to_replace == DeleteStage::BeforeInspect {
            result.unwrap();
        } else {
            assert!(result.unwrap_err().partial);
        }
        assert_eq!(
            fs::read(f.0.join("outside/sentinel.md")).unwrap(),
            b"outside"
        );
    }
}
#[cfg(windows)]
#[test]
fn delete_junction_is_nonrecursive_and_retained_directory_blocks_replacement() {
    let f = Fixture::new();
    let (a, s, _) = f.access();
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(f.0.join("work/tree/junction"))
        .arg(f.0.join("outside"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "junction fixture required: {output:?}"
    );
    let mut checked = false;
    a.delete_tree_with(
        "main",
        s.id,
        Path::new("tree"),
        DeleteLimits::default(),
        &mut |stage, _, name| {
            if stage == DeleteStage::AfterOpen && name == "tree" {
                assert!(fs::rename(f.0.join("work/tree"), f.0.join("held-tree")).is_err());
                checked = true;
            }
            Ok(())
        },
    )
    .unwrap();
    assert!(checked);
    assert!(!f.0.join("work/tree").exists());
    assert_eq!(
        fs::read(f.0.join("outside/sentinel.md")).unwrap(),
        b"outside"
    );
}
