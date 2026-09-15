use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("mdw-access-{}", Uuid::new_v4()));
        fs::create_dir_all(path.join("root/inside")).unwrap();
        fs::create_dir(path.join("outside")).unwrap();
        fs::write(path.join("root/doc.md"), b"\xef\xbb\xbf# original\r\n").unwrap();
        fs::write(path.join("root/inside/read.md"), b"inside").unwrap();
        fs::write(path.join("outside/secret.md"), b"outside secret").unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    fn broker(&self) -> FileAccess {
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

#[test]
fn document_read_preserves_raw_bytes_and_does_not_grant_its_siblings() {
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    let grant = access
        .grant_file_from_native_selection(
            "main",
            &fixture.path("root/doc.md"),
            GrantKind::Document,
            Rights::READ_WRITE,
        )
        .unwrap();
    assert_eq!(
        access.read("main", grant.id, Path::new(""), 100).unwrap(),
        b"\xef\xbb\xbf# original\r\n"
    );
    assert!(matches!(
        access.read("main", grant.id, Path::new("inside/read.md"), 100),
        Err(AccessError::Denied)
    ));
    assert!(access
        .create_new("main", grant.id, Path::new(""), b"replacement")
        .is_err());
    assert_eq!(
        fs::read(fixture.path("root/doc.md")).unwrap(),
        b"\xef\xbb\xbf# original\r\n"
    );
}

#[test]
fn window_ownership_revocation_and_non_escalating_transfer_are_enforced() {
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    let grant = fixture.workspace(&mut access, Rights::READ);
    assert!(matches!(
        access.read("window-1", grant.id, Path::new("doc.md"), 100),
        Err(AccessError::Denied)
    ));
    assert!(access
        .transfer("main", "window-1", grant.id, Rights::READ_WRITE)
        .is_err());
    let copy = access
        .transfer("main", "window-1", grant.id, Rights::READ)
        .unwrap();
    assert_ne!(grant.id, copy.id);
    access.revoke("main", grant.id);
    assert!(access
        .read("main", grant.id, Path::new("doc.md"), 100)
        .is_err());
    assert!(access
        .read("window-1", copy.id, Path::new("doc.md"), 100)
        .is_ok());
    access.revoke_window("window-1");
    access.register_window("window-1").unwrap();
    assert!(access
        .read("window-1", copy.id, Path::new("doc.md"), 100)
        .is_err());
}

#[test]
fn unknown_and_preview_windows_cannot_acquire_or_receive_grants() {
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    for label in [
        "window-print",
        "preview",
        "window-0",
        "window-01",
        "window-+1",
        "window-4294967296",
        "window--1",
        "window-1-preview",
        "",
    ] {
        assert!(access.register_window(label).is_err());
        assert!(access
            .grant_directory_from_native_selection(
                label,
                &fixture.path("root"),
                GrantKind::Workspace,
                Rights::READ
            )
            .is_err());
    }
    let grant = fixture.workspace(&mut access, Rights::READ);
    assert!(access
        .transfer("main", "window-999", grant.id, Rights::READ)
        .is_err());
    assert!(access
        .transfer("main", "window-print", grant.id, Rights::READ)
        .is_err());
    assert!(GrantId::parse("/tmp/a.md").is_err());
    assert_eq!(GrantId::parse(&grant.id.to_string()).unwrap(), grant.id);
}

#[test]
fn separate_read_write_rights_and_scope_kinds_are_retained() {
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    let read = fixture.workspace(&mut access, Rights::READ);
    assert!(access
        .create_new("main", read.id, Path::new("new.md"), b"no")
        .is_err());
    let write = access
        .grant_directory_from_native_selection(
            "main",
            &fixture.path("root"),
            GrantKind::Resource,
            Rights::WRITE,
        )
        .unwrap();
    assert!(access
        .read("main", write.id, Path::new("doc.md"), 100)
        .is_err());
    access
        .create_new("main", write.id, Path::new("new.png"), b"bytes")
        .unwrap();
    assert_eq!(fs::read(fixture.path("root/new.png")).unwrap(), b"bytes");
    let info = access.describe("main", write.id).unwrap();
    assert_eq!(info.kind, GrantKind::Resource);
    assert_eq!(info.rights, Rights::WRITE);
    assert!(access
        .grant_file_from_native_selection(
            "main",
            &fixture.path("root/doc.md"),
            GrantKind::Workspace,
            Rights::READ
        )
        .is_err());
    assert!(access
        .grant_directory_from_native_selection(
            "main",
            &fixture.path("root"),
            GrantKind::Document,
            Rights::READ
        )
        .is_err());
}

#[test]
fn export_grants_create_only_the_selected_new_file() {
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    let target = fixture.path("root/export.html");
    let grant = access
        .grant_file_from_native_selection("main", &target, GrantKind::Export, Rights::WRITE)
        .unwrap();
    assert!(access
        .create_new("main", grant.id, Path::new("other.html"), b"no")
        .is_err());
    access
        .create_new("main", grant.id, Path::new(""), b"export")
        .unwrap();
    assert!(access
        .create_new("main", grant.id, Path::new(""), b"clobber")
        .is_err());
    assert_eq!(fs::read(target).unwrap(), b"export");
}

#[test]
fn operation_paths_reject_traversal_prefixes_unc_ads_and_ambiguous_names() {
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    let grant = fixture.workspace(&mut access, Rights::READ_WRITE);
    for path in [
        "",
        ".",
        "..",
        "../outside/secret.md",
        "inside/../../outside/secret.md",
        "/outside/secret.md",
        "inside/./read.md",
        "inside//read.md",
        "inside\\read.md",
        "C:/secret.md",
        "C:secret.md",
        "//server/share/secret.md",
        "\\\\?\\C:\\secret.md",
        "doc.md:secret",
        "NUL.md",
        "COM1.txt",
        "COM¹",
        "com².md",
        "COM³.tar.gz",
        "LPT¹",
        "lpt².png",
        "LPT³.txt",
        "read.md.",
        "read.md ",
    ] {
        assert!(
            access.read("main", grant.id, Path::new(path), 100).is_err(),
            "read accepted {path}"
        );
        assert!(
            access
                .create_new("main", grant.id, Path::new(path), b"no")
                .is_err(),
            "write accepted {path}"
        );
    }
    assert_eq!(
        fs::read(fixture.path("outside/secret.md")).unwrap(),
        b"outside secret"
    );
    assert!(!fixture.path("root/C:secret.md").exists());
}

#[test]
fn limits_and_non_regular_files_are_rejected_before_reading() {
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    let grant = fixture.workspace(&mut access, Rights::READ);
    assert!(matches!(
        access.read("main", grant.id, Path::new("doc.md"), 1),
        Err(AccessError::TooLarge)
    ));
    assert!(matches!(
        access.read("main", grant.id, Path::new("doc.md"), MAX_IO_BYTES + 1),
        Err(AccessError::TooLarge)
    ));
    assert!(access
        .read("main", grant.id, Path::new("inside"), 100)
        .is_err());
}

#[cfg(unix)]
fn link_file(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}
#[cfg(windows)]
fn link_file(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_file(target, link)
        .expect("native symlink security tests require Developer Mode or symlink privilege");
}
#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}
#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_dir(target, link)
        .expect("native symlink security tests require Developer Mode or symlink privilege");
}

#[test]
fn file_and_directory_symlinks_cannot_escape_or_alias_other_grants() {
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    let grant = fixture.workspace(&mut access, Rights::READ_WRITE);
    link_file(
        &fixture.path("outside/secret.md"),
        &fixture.path("root/link.md"),
    );
    link_dir(&fixture.path("outside"), &fixture.path("root/linked"));
    // Even links pointing inside the grant are rejected: an exact file grant
    // must not turn into access to another file under its parent.
    link_file(Path::new("doc.md"), &fixture.path("root/alias.md"));
    for path in ["link.md", "linked/secret.md", "alias.md"] {
        assert!(access.read("main", grant.id, Path::new(path), 100).is_err());
        assert!(access
            .create_new("main", grant.id, Path::new(path), b"attack")
            .is_err());
    }
    assert!(access
        .create_new("main", grant.id, Path::new("linked/new.md"), b"attack")
        .is_err());
    assert!(!fixture.path("outside/new.md").exists());
}

#[test]
fn leaf_replacement_after_exact_file_grant_cannot_redirect_reads() {
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    let grant = access
        .grant_file_from_native_selection(
            "main",
            &fixture.path("root/doc.md"),
            GrantKind::Document,
            Rights::READ,
        )
        .unwrap();
    fs::remove_file(fixture.path("root/doc.md")).unwrap();
    link_file(
        &fixture.path("outside/secret.md"),
        &fixture.path("root/doc.md"),
    );
    assert!(access.read("main", grant.id, Path::new(""), 100).is_err());
}

#[test]
fn pinned_root_does_not_reopen_an_attacker_replacement_path() {
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    let grant = fixture.workspace(&mut access, Rights::READ_WRITE);
    let moved = fs::rename(fixture.path("root"), fixture.path("old-root"));
    #[cfg(windows)]
    if let Err(error) = &moved {
        assert!(
            matches!(error.raw_os_error(), Some(5 | 32)),
            "unexpected rename failure: {error}"
        );
        // Windows capability directory handles deny FILE_SHARE_DELETE, so a
        // parent rename is prevented while the grant exists.
        assert!(access
            .read("main", grant.id, Path::new("doc.md"), 100)
            .is_ok());
        return;
    }
    moved.unwrap();
    link_dir(&fixture.path("outside"), &fixture.path("root"));
    assert_eq!(
        access
            .read("main", grant.id, Path::new("doc.md"), 100)
            .unwrap(),
        b"\xef\xbb\xbf# original\r\n"
    );
    access
        .create_new("main", grant.id, Path::new("new.md"), b"authorized object")
        .unwrap();
    assert!(fixture.path("old-root/new.md").is_file());
    assert!(!fixture.path("outside/new.md").exists());
}

#[cfg(unix)]
#[test]
fn concurrent_parent_symlink_swaps_never_read_or_write_outside() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    let grant = fixture.workspace(&mut access, Rights::READ_WRITE);
    fs::write(fixture.path("outside/read.md"), b"outside secret").unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let writer_stop = stop.clone();
    let inside = fixture.path("root/inside");
    let parked = fixture.path("root/parked");
    let outside = fixture.path("outside");
    let writer = std::thread::spawn(move || {
        while !writer_stop.load(Ordering::SeqCst) {
            fs::rename(&inside, &parked).unwrap();
            std::os::unix::fs::symlink(&outside, &inside).unwrap();
            std::thread::yield_now();
            fs::remove_file(&inside).unwrap();
            fs::rename(&parked, &inside).unwrap();
        }
    });
    let mut escaped_read = false;
    for index in 0..200 {
        if let Ok(bytes) = access.read("main", grant.id, Path::new("inside/read.md"), 100) {
            escaped_read |= bytes != b"inside";
        }
        let _ = access.create_new(
            "main",
            grant.id,
            Path::new(&format!("inside/new-{index}.md")),
            b"allowed",
        );
    }
    stop.store(true, Ordering::SeqCst);
    writer.join().unwrap();
    assert!(!escaped_read, "a concurrent symlink swap redirected a read");
    assert_eq!(fs::read_dir(fixture.path("outside")).unwrap().count(), 2);
}

#[cfg(windows)]
#[test]
fn junction_targets_are_denied_by_handle_traversal() {
    let fixture = Fixture::new();
    let mut access = fixture.broker();
    let grant = fixture.workspace(&mut access, Rights::READ_WRITE);
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(fixture.path("root/junction"))
        .arg(fixture.path("outside"))
        .status()
        .unwrap();
    assert!(
        status.success(),
        "junction creation must succeed for this native security test"
    );
    assert!(access
        .read("main", grant.id, Path::new("junction/secret.md"), 100)
        .is_err());
    assert!(access
        .create_new("main", grant.id, Path::new("junction/new.md"), b"attack")
        .is_err());
    assert!(!fixture.path("outside/new.md").exists());
}
