use super::*;
use std::{cell::Cell, fs};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("mdw-reveal-{}", Uuid::new_v4()));
        fs::create_dir_all(path.join("root/inside")).unwrap();
        fs::write(path.join("root/doc.md"), b"data").unwrap();
        fs::write(path.join("root/inside/empty.md"), b"").unwrap();
        fs::write(path.join("outside.md"), b"outside").unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    fn access(&self) -> FileAccess {
        let mut access = FileAccess::default();
        access.register_window("main").unwrap();
        access.register_window("window-1").unwrap();
        access
    }
    fn workspace(&self, access: &mut FileAccess, rights: Rights) -> GrantInfo {
        access
            .grant_directory_from_native_selection(
                "main",
                &self.path("root"),
                GrantKind::Workspace,
                rights,
            )
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn assert_denied(access: &FileAccess, label: &str, id: GrantId, relative: &str) {
    let called = Cell::new(false);
    assert!(access
        .reveal(label, id, Path::new(relative), |_| {
            called.set(true);
            Ok(())
        })
        .is_err());
    assert!(!called.get());
}

#[test]
fn reveal_regular_files_directories_empty_files_and_workspace_itself() {
    let f = Fixture::new();
    let mut access = f.access();
    let grant = f.workspace(&mut access, Rights::READ);
    for relative in ["", "doc.md", "inside", "inside/empty.md"] {
        let expected = if relative.is_empty() {
            f.path("root")
        } else {
            f.path("root").join(relative)
        };
        let called = Cell::new(0);
        access
            .reveal("main", grant.id, Path::new(relative), |path| {
                assert_eq!(path, expected);
                called.set(called.get() + 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(called.get(), 1);
    }
}

#[test]
fn reveal_exact_read_grant_never_supplies_sibling_or_directory_access() {
    let f = Fixture::new();
    let mut access = f.access();
    let grant = access
        .grant_file_from_native_selection(
            "main",
            &f.path("root/doc.md"),
            GrantKind::Resource,
            Rights::READ,
        )
        .unwrap();
    access
        .reveal("main", grant.id, Path::new(""), |path| {
            assert_eq!(path, f.path("root/doc.md"));
            Ok(())
        })
        .unwrap();
    assert_denied(&access, "main", grant.id, "inside/empty.md");
    assert_denied(&access, "window-1", grant.id, "");
    assert_denied(&access, "print-preview", grant.id, "");
    access.revoke("main", grant.id);
    assert_denied(&access, "main", grant.id, "");
}

#[test]
fn reveal_write_only_exports_and_missing_targets_never_launch() {
    let f = Fixture::new();
    let mut access = f.access();
    let export = access
        .grant_file_from_native_selection(
            "main",
            &f.path("root/doc.md"),
            GrantKind::Export,
            Rights::WRITE,
        )
        .unwrap();
    assert_denied(&access, "main", export.id, "");
    let grant = f.workspace(&mut access, Rights::READ);
    assert_denied(&access, "main", grant.id, "missing.md");
}

#[test]
fn reveal_rejects_invalid_relative_spellings_before_launch() {
    let f = Fixture::new();
    let mut access = f.access();
    let grant = f.workspace(&mut access, Rights::READ);
    for relative in [
        "../outside.md",
        "/outside.md",
        "inside/../doc.md",
        "inside/./empty.md",
        "inside//empty.md",
        "doc.md/",
        "doc.md:stream",
        "NUL",
        "a\0b",
        "a\nb",
        "a\\b",
        "a\"b",
        "a. ",
    ] {
        assert_denied(&access, "main", grant.id, relative);
    }
}

#[test]
fn reveal_reports_launcher_failure_without_mutation() {
    let f = Fixture::new();
    let mut access = f.access();
    let grant = f.workspace(&mut access, Rights::READ);
    let result = access.reveal("main", grant.id, Path::new("doc.md"), |_| {
        Err(io::Error::other("launcher failed"))
    });
    assert!(matches!(result, Err(AccessError::Io(_))));
    assert_eq!(fs::read(f.path("root/doc.md")).unwrap(), b"data");
}

#[test]
fn reveal_selected_filesystem_root_has_a_nonempty_absolute_locator() {
    let f = Fixture::new();
    let mut access = f.access();
    let root = f.0.ancestors().last().unwrap();
    let grant = access
        .grant_directory_from_native_selection("main", root, GrantKind::Workspace, Rights::READ)
        .unwrap();
    access
        .reveal("main", grant.id, Path::new(""), |path| {
            assert!(path.is_absolute());
            assert_eq!(path, root);
            Ok(())
        })
        .unwrap();
}

#[cfg(unix)]
#[test]
fn reveal_rejects_symlink_substitution_but_native_selection_alias_uses_target() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    symlink(f.path("root/doc.md"), f.path("alias.md")).unwrap();
    let mut access = f.access();
    let exact = access
        .grant_file_from_native_selection(
            "main",
            &f.path("alias.md"),
            GrantKind::Document,
            Rights::READ,
        )
        .unwrap();
    fs::remove_file(f.path("alias.md")).unwrap();
    symlink(f.path("outside.md"), f.path("alias.md")).unwrap();
    access
        .reveal("main", exact.id, Path::new(""), |path| {
            assert_eq!(path, f.path("root/doc.md"));
            Ok(())
        })
        .unwrap();
    let grant = f.workspace(&mut access, Rights::READ);
    symlink(f.path("outside.md"), f.path("root/link.md")).unwrap();
    symlink(f.path("root/inside"), f.path("root/linkdir")).unwrap();
    assert_denied(&access, "main", grant.id, "link.md");
    assert_denied(&access, "main", grant.id, "linkdir");
    assert_denied(&access, "main", grant.id, "linkdir/empty.md");
}

#[cfg(unix)]
#[test]
fn reveal_retained_parent_replacement_cannot_launch_even_with_hardlinked_leaf() {
    let f = Fixture::new();
    let mut access = f.access();
    let grant = f.workspace(&mut access, Rights::READ);
    fs::rename(f.path("root"), f.path("moved")).unwrap();
    fs::create_dir(f.path("root")).unwrap();
    fs::hard_link(f.path("moved/doc.md"), f.path("root/doc.md")).unwrap();
    assert_eq!(
        access
            .read("main", grant.id, Path::new("doc.md"), 20)
            .unwrap(),
        b"data"
    );
    assert_denied(&access, "main", grant.id, "doc.md");
    assert_denied(&access, "main", grant.id, "");
}

#[cfg(unix)]
#[test]
fn reveal_rechecks_opened_leaf_and_intermediate_directory_before_dispatch() {
    let f = Fixture::new();
    let mut access = f.access();
    let grant = f.workspace(&mut access, Rights::READ);
    for directory_swap in [false, true] {
        let called = Cell::new(false);
        let relative = if directory_swap {
            "inside/empty.md"
        } else {
            "doc.md"
        };
        let result = access.reveal_with_hook(
            "main",
            grant.id,
            Path::new(relative),
            || {
                if directory_swap {
                    fs::rename(f.path("root/inside"), f.path("old-inside"))?;
                    fs::create_dir(f.path("root/inside"))?;
                    fs::hard_link(
                        f.path("old-inside/empty.md"),
                        f.path("root/inside/empty.md"),
                    )?;
                } else {
                    fs::rename(f.path("root/doc.md"), f.path("old.md"))?;
                    fs::write(f.path("root/doc.md"), b"replacement")?;
                }
                Ok(())
            },
            |_| {
                called.set(true);
                Ok(())
            },
        );
        assert!(matches!(result, Err(AccessError::Denied)));
        assert!(!called.get());
    }
}

#[cfg(unix)]
#[test]
fn reveal_special_file_is_rejected_without_blocking() {
    let f = Fixture::new();
    let mut access = f.access();
    let grant = f.workspace(&mut access, Rights::READ);
    // FIFO paths do not have the short Unix-domain socket pathname limit.
    assert!(std::process::Command::new("mkfifo")
        .arg(f.path("root/pipe"))
        .status()
        .unwrap()
        .success());
    assert_denied(&access, "main", grant.id, "pipe");
}

#[cfg(windows)]
#[test]
fn reveal_windows_junction_and_its_descendants_are_denied() {
    let f = Fixture::new();
    let junction = f.path("root/junction");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(f.path("root/inside"))
        .status()
        .unwrap();
    assert!(status.success(), "junction fixture must be created");
    let mut access = f.access();
    let grant = f.workspace(&mut access, Rights::READ);
    assert_denied(&access, "main", grant.id, "junction");
    assert_denied(&access, "main", grant.id, "junction/empty.md");
    fs::remove_dir(junction).unwrap();
}
