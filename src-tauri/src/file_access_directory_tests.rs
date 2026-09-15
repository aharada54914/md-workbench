use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-list-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("workspace/日本語 folder/nested")).unwrap();
        fs::write(root.join("workspace/z.md"), b"original").unwrap();
        fs::write(root.join("workspace/日本語 folder/a.md"), b"child").unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        fs::write(root.join("outside/secret.md"), b"private").unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn broker(&self, rights: Rights) -> (FileAccess, GrantInfo) {
        let mut access = FileAccess::default();
        access.register_window("main").unwrap();
        access.register_window("window-1").unwrap();
        let grant = access
            .grant_directory_from_native_selection(
                "main",
                &self.0.join("workspace"),
                GrantKind::Workspace,
                rights,
            )
            .unwrap();
        (access, grant)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn lists_direct_children_and_nested_unicode_directory_without_changing_bytes() {
    let fixture = Fixture::new();
    let (access, grant) = fixture.broker(Rights::READ);
    let listing = access
        .list_directory("main", grant.id, Path::new(""), 2)
        .unwrap();
    assert_eq!(
        listing.entries,
        vec![
            DirectoryEntry {
                name: "日本語 folder".into(),
                is_directory: true
            },
            DirectoryEntry {
                name: "z.md".into(),
                is_directory: false
            },
        ]
    );
    assert_eq!(listing.omitted, 0);
    let nested = access
        .list_directory("main", grant.id, Path::new("日本語 folder"), 2)
        .unwrap();
    assert_eq!(nested.entries[0].name, "nested");
    assert_eq!(nested.entries[1].name, "a.md");
    assert_eq!(
        fs::read(fixture.0.join("workspace/z.md")).unwrap(),
        b"original"
    );
}

#[test]
fn denies_foreign_revoked_write_only_and_exact_file_grants() {
    let fixture = Fixture::new();
    let (mut access, grant) = fixture.broker(Rights::WRITE);
    assert!(matches!(
        access.list_directory("main", grant.id, Path::new(""), 10),
        Err(AccessError::Denied)
    ));
    let readable = fixture.broker(Rights::READ);
    assert!(matches!(
        readable
            .0
            .list_directory("window-1", readable.1.id, Path::new(""), 10),
        Err(AccessError::Denied)
    ));
    let file = access
        .grant_file_from_native_selection(
            "main",
            &fixture.0.join("workspace/z.md"),
            GrantKind::Document,
            Rights::READ,
        )
        .unwrap();
    assert!(matches!(
        access.list_directory("main", file.id, Path::new(""), 10),
        Err(AccessError::InvalidKind)
    ));
    access.revoke("main", file.id);
    assert!(matches!(
        access.list_directory("main", file.id, Path::new(""), 10),
        Err(AccessError::Denied)
    ));
}

#[test]
fn denies_traversal_absolute_and_ambiguous_directory_names() {
    let fixture = Fixture::new();
    let (access, grant) = fixture.broker(Rights::READ);
    for path in [
        "../outside",
        "/outside",
        "日本語 folder/../..",
        ".",
        "日本語 folder/",
        "日本語 folder//nested",
        "C:/outside",
        "x:stream",
    ] {
        assert!(
            access
                .list_directory("main", grant.id, Path::new(path), 10)
                .is_err(),
            "{path}"
        );
    }
}

#[test]
fn bounds_enumeration_and_returns_no_incomplete_success() {
    let fixture = Fixture::new();
    let (access, grant) = fixture.broker(Rights::READ);
    for limit in [0, 1, MAX_DIRECTORY_ENTRIES + 1] {
        assert!(matches!(
            access.list_directory("main", grant.id, Path::new(""), limit),
            Err(AccessError::TooLarge)
        ));
    }
    assert!(access
        .list_directory("main", grant.id, Path::new("日本語 folder/nested"), 0)
        .unwrap()
        .entries
        .is_empty());
}

#[cfg(unix)]
#[test]
fn excludes_symlinks_and_nonportable_names_without_following_them() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let (access, grant) = fixture.broker(Rights::READ);
    let root = fixture.0.join("workspace");
    symlink(fixture.0.join("outside"), root.join("escape")).unwrap();
    symlink(
        fixture.0.join("outside/secret.md"),
        root.join("secret-link.md"),
    )
    .unwrap();
    fs::write(root.join("CON"), b"device alias").unwrap();
    let listing = access
        .list_directory("main", grant.id, Path::new(""), 5)
        .unwrap();
    assert_eq!(listing.entries.len(), 2);
    assert_eq!(listing.omitted, 3);
    assert!(matches!(
        access.list_directory("main", grant.id, Path::new(""), 4),
        Err(AccessError::TooLarge)
    ));
    assert!(access
        .list_directory("main", grant.id, Path::new("escape"), 10)
        .is_err());
    assert_eq!(
        fs::read(fixture.0.join("outside/secret.md")).unwrap(),
        b"private"
    );
}

// APFS refuses this name at creation time; exercise real non-UTF-8 entries on Linux.
#[cfg(target_os = "linux")]
#[test]
fn reports_non_utf8_names_as_omitted() {
    use std::os::unix::ffi::OsStringExt;
    let fixture = Fixture::new();
    let (access, grant) = fixture.broker(Rights::READ);
    fs::write(
        fixture
            .0
            .join("workspace")
            .join(OsString::from_vec(vec![0xff])),
        b"non UTF-8",
    )
    .unwrap();
    let listing = access
        .list_directory("main", grant.id, Path::new(""), 3)
        .unwrap();
    assert_eq!(listing.entries.len(), 2);
    assert_eq!(listing.omitted, 1);
}

#[cfg(unix)]
#[test]
fn retained_directory_does_not_follow_replacement_at_selected_path() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let (access, grant) = fixture.broker(Rights::READ);
    fs::rename(
        fixture.0.join("workspace"),
        fixture.0.join("original-workspace"),
    )
    .unwrap();
    symlink(fixture.0.join("outside"), fixture.0.join("workspace")).unwrap();
    let listing = access
        .list_directory("main", grant.id, Path::new(""), 10)
        .unwrap();
    assert!(listing.entries.iter().any(|entry| entry.name == "z.md"));
    assert!(!listing
        .entries
        .iter()
        .any(|entry| entry.name == "secret.md"));
}

#[cfg(windows)]
#[test]
fn junction_is_omitted_and_cannot_be_enumerated() {
    let fixture = Fixture::new();
    let (access, grant) = fixture.broker(Rights::READ);
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(fixture.0.join("workspace/junction"))
        .arg(fixture.0.join("outside"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "native junction fixture must be created: {output:?}"
    );
    let listing = access
        .list_directory("main", grant.id, Path::new(""), 10)
        .unwrap();
    assert_eq!(listing.omitted, 1);
    assert!(!listing.entries.iter().any(|entry| entry.name == "junction"));
    assert!(access
        .list_directory("main", grant.id, Path::new("junction"), 10)
        .is_err());
    assert_eq!(
        fs::read(fixture.0.join("outside/secret.md")).unwrap(),
        b"private"
    );
}
