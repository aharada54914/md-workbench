use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-image-{}", Uuid::new_v4()));
        for dir in ["work/images/nested", "work/note.assets", "outside/images"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join("work/note.md"), b"document").unwrap();
        fs::write(
            root.join("work/images/nested/雪 (1).png"),
            b"\0\xfforiginal",
        )
        .unwrap();
        fs::write(root.join("work/note.assets/image.png"), b"asset").unwrap();
        fs::write(root.join("outside/images/secret.png"), b"secret").unwrap();
        fs::write(root.join("outside/secret.md"), b"outside document").unwrap();
        Self(root)
    }
    fn access(&self, kind: GrantKind, rights: Rights) -> (FileAccess, GrantInfo) {
        let mut access = FileAccess::default();
        access.register_window("main").unwrap();
        access.register_window("window-1").unwrap();
        let grant = if kind == GrantKind::Workspace {
            access.grant_directory_from_native_selection("main", &self.0.join("work"), kind, rights)
        } else {
            access.grant_file_from_native_selection(
                "main",
                &self.0.join("work/note.md"),
                kind,
                rights,
            )
        }
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
fn image_bytes_are_transient_and_use_native_document_stem() {
    let f = Fixture::new();
    let (access, grant) = f.access(GrantKind::Document, Rights::READ);
    let count = access.grants.len();
    for (path, expected) in [
        ("images/nested/雪 (1).png", b"\0\xfforiginal".as_slice()),
        ("note.assets/image.png", b"asset".as_slice()),
    ] {
        assert_eq!(
            access
                .read_document_image("main", grant.id, Path::new(""), Path::new(path))
                .unwrap(),
            expected
        );
    }
    assert_eq!(access.grants.len(), count);
    for path in [
        "note.md.assets/image.png",
        "other.assets/image.png",
        "images",
        "note.assets",
        "secret.png",
    ] {
        assert!(
            matches!(
                access.read_document_image("main", grant.id, Path::new(""), Path::new(path)),
                Err(AccessError::Denied)
            ),
            "{path}"
        );
    }
    assert_eq!(fs::read(f.0.join("work/note.md")).unwrap(), b"document");
}

#[test]
fn workspace_documents_use_their_own_nested_parent() {
    let f = Fixture::new();
    fs::create_dir_all(f.0.join("work/sub/images")).unwrap();
    fs::write(f.0.join("work/sub/child.md"), b"child").unwrap();
    fs::write(f.0.join("work/sub/images/a.png"), b"nested").unwrap();
    let (access, grant) = f.access(GrantKind::Workspace, Rights::READ);
    assert_eq!(
        access
            .read_document_image(
                "main",
                grant.id,
                Path::new("sub/child.md"),
                Path::new("images/a.png")
            )
            .unwrap(),
        b"nested"
    );
    for document in ["", "sub", "sub/../note.md"] {
        assert!(access
            .validate_image_document("main", grant.id, Path::new(document))
            .is_err());
    }
}

#[test]
fn images_require_owned_read_document_or_workspace_and_current_regular_document() {
    let f = Fixture::new();
    for kind in [GrantKind::Resource, GrantKind::Export] {
        let (access, grant) = f.access(kind, Rights::READ);
        assert!(matches!(
            access.validate_image_document("main", grant.id, Path::new("")),
            Err(AccessError::InvalidKind)
        ));
        assert!(matches!(
            access.read_document_image(
                "main",
                grant.id,
                Path::new(""),
                Path::new("images/nested/雪 (1).png")
            ),
            Err(AccessError::InvalidKind)
        ));
    }
    let (access, grant) = f.access(GrantKind::Document, Rights::WRITE);
    assert!(matches!(
        access.validate_image_document("main", grant.id, Path::new("")),
        Err(AccessError::Denied)
    ));
    drop(access);
    let (mut access, grant) = f.access(GrantKind::Document, Rights::READ);
    for label in ["window-1", "print-preview", "unknown"] {
        assert!(matches!(
            access.validate_image_document(label, grant.id, Path::new("")),
            Err(AccessError::Denied)
        ));
    }
    assert!(matches!(
        access.validate_image_document("main", grant.id, Path::new("note.md")),
        Err(AccessError::Denied)
    ));
    fs::remove_file(f.0.join("work/note.md")).unwrap();
    fs::create_dir(f.0.join("work/note.md")).unwrap();
    assert!(matches!(
        access.validate_image_document("main", grant.id, Path::new("")),
        Err(AccessError::InvalidPath)
    ));
    access.revoke_window("main");
    assert!(matches!(
        access.validate_image_document("main", grant.id, Path::new("")),
        Err(AccessError::Denied)
    ));
}

#[test]
fn images_reject_nonportable_paths_and_treat_percent_escapes_literally() {
    let f = Fixture::new();
    let (access, grant) = f.access(GrantKind::Document, Rights::READ);
    for path in [
        "",
        "/images/a",
        "../outside/images/secret.png",
        "images/../secret",
        "images/./a",
        "images//a",
        "images/a:stream",
        "images/CON.png",
        "images/LPT².png",
        "images/a\\b",
        "images/trailing.",
        "images/a/",
    ] {
        assert!(
            matches!(
                access.read_document_image("main", grant.id, Path::new(""), Path::new(path)),
                Err(AccessError::InvalidPath)
            ),
            "{path}"
        );
    }
    fs::create_dir(f.0.join("work/images/%2e%2e")).unwrap();
    fs::write(f.0.join("work/images/%2e%2e/%2fsecret.png"), b"literal").unwrap();
    assert_eq!(
        access
            .read_document_image(
                "main",
                grant.id,
                Path::new(""),
                Path::new("images/%2e%2e/%2fsecret.png")
            )
            .unwrap(),
        b"literal"
    );
    assert!(access
        .read_document_image(
            "main",
            grant.id,
            Path::new(""),
            Path::new("images%2f../outside/images/secret.png")
        )
        .is_err());
    assert_eq!(
        fs::read(f.0.join("outside/images/secret.png")).unwrap(),
        b"secret"
    );
    for path in [
        format!("images/{}", "a".repeat(MAX_IMAGE_PATH_BYTES)),
        format!("images/{}a", "a/".repeat(MAX_IMAGE_DEPTH)),
    ] {
        assert!(matches!(
            access.read_document_image("main", grant.id, Path::new(""), Path::new(&path)),
            Err(AccessError::TooLarge)
        ));
    }
}

#[test]
fn images_enforce_eight_mib_before_and_during_read() {
    let f = Fixture::new();
    let (access, grant) = f.access(GrantKind::Document, Rights::READ);
    let path = f.0.join("work/images/limit.png");
    fs::write(&path, vec![7; MAX_DOCUMENT_IMAGE_BYTES]).unwrap();
    assert_eq!(
        access
            .read_document_image(
                "main",
                grant.id,
                Path::new(""),
                Path::new("images/limit.png")
            )
            .unwrap()
            .len(),
        MAX_DOCUMENT_IMAGE_BYTES
    );
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAX_DOCUMENT_IMAGE_BYTES as u64 + 1)
        .unwrap();
    assert!(matches!(
        access.read_document_image(
            "main",
            grant.id,
            Path::new(""),
            Path::new("images/limit.png")
        ),
        Err(AccessError::TooLarge)
    ));
    fs::write(&path, b"small").unwrap();
    let result = access.read_document_image_with_hooks(
        "main",
        grant.id,
        Path::new(""),
        Path::new("images/limit.png"),
        || Ok(()),
        || {
            fs::OpenOptions::new()
                .write(true)
                .open(&path)?
                .set_len(MAX_DOCUMENT_IMAGE_BYTES as u64 + 1)
        },
    );
    assert!(matches!(result, Err(AccessError::TooLarge)));
}

#[cfg(unix)]
#[test]
fn images_and_documents_reject_links_and_special_files() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let (access, grant) = f.access(GrantKind::Workspace, Rights::READ);
    symlink(f.0.join("outside"), f.0.join("work/link")).unwrap();
    assert!(access
        .validate_image_document("main", grant.id, Path::new("link/secret.md"))
        .is_err());
    symlink(f.0.join("outside/images"), f.0.join("work/images/link")).unwrap();
    symlink(
        f.0.join("outside/images/secret.png"),
        f.0.join("work/images/leaf.png"),
    )
    .unwrap();
    for path in ["images/link/secret.png", "images/leaf.png"] {
        assert!(access
            .read_document_image("main", grant.id, Path::new("note.md"), Path::new(path))
            .is_err());
    }
    let fifo = f.0.join("work/images/fifo");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    assert!(matches!(
        access.read_document_image(
            "main",
            grant.id,
            Path::new("note.md"),
            Path::new("images/fifo")
        ),
        Err(AccessError::InvalidPath)
    ));
    fs::remove_file(f.0.join("work/note.md")).unwrap();
    symlink(
        f.0.join("outside/images/secret.png"),
        f.0.join("work/note.md"),
    )
    .unwrap();
    assert!(access
        .validate_image_document("main", grant.id, Path::new("note.md"))
        .is_err());
    assert_eq!(
        fs::read(f.0.join("outside/images/secret.png")).unwrap(),
        b"secret"
    );
}

#[cfg(unix)]
#[test]
fn image_reads_keep_the_document_parent_handle_across_namespace_substitution() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let (access, grant) = f.access(GrantKind::Workspace, Rights::READ);
    let result = access.read_document_image_with_hooks(
        "main",
        grant.id,
        Path::new("note.md"),
        Path::new("note.assets/image.png"),
        || {
            fs::rename(f.0.join("work"), f.0.join("held"))?;
            symlink(f.0.join("outside"), f.0.join("work"))
        },
        || Ok(()),
    );
    assert_eq!(result.unwrap(), b"asset");
    assert_eq!(
        access
            .read_document_image(
                "main",
                grant.id,
                Path::new("note.md"),
                Path::new("note.assets/image.png")
            )
            .unwrap(),
        b"asset"
    );
    assert_eq!(
        fs::read(f.0.join("outside/images/secret.png")).unwrap(),
        b"secret"
    );
}

#[cfg(windows)]
#[test]
fn images_reject_windows_junction_asset_roots_and_document_parents() {
    let f = Fixture::new();
    let (access, grant) = f.access(GrantKind::Workspace, Rights::READ);
    for (link, target) in [
        ("work/note.assets/junction", "outside/images"),
        ("work/junction", "outside"),
    ] {
        assert!(std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(f.0.join(link))
            .arg(f.0.join(target))
            .output()
            .unwrap()
            .status
            .success());
    }
    assert!(access
        .read_document_image(
            "main",
            grant.id,
            Path::new("note.md"),
            Path::new("note.assets/junction/secret.png")
        )
        .is_err());
    assert!(access
        .validate_image_document("main", grant.id, Path::new("junction/secret.md"))
        .is_err());
    fs::rename(f.0.join("work/note.assets"), f.0.join("work/held.assets")).unwrap();
    assert!(std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(f.0.join("work/note.assets"))
        .arg(f.0.join("outside/images"))
        .output()
        .unwrap()
        .status
        .success());
    assert!(access
        .read_document_image(
            "main",
            grant.id,
            Path::new("note.md"),
            Path::new("note.assets/secret.png")
        )
        .is_err());
    assert_eq!(
        fs::read(f.0.join("outside/images/secret.png")).unwrap(),
        b"secret"
    );
}

#[cfg(windows)]
#[test]
fn images_reject_windows_file_and_directory_symlinks() {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let f = Fixture::new();
    let (access, grant) = f.access(GrantKind::Workspace, Rights::READ);
    symlink_dir(f.0.join("outside/images"), f.0.join("work/images/link"))
        .expect("native symlink security tests require Developer Mode or symlink privilege");
    symlink_file(
        f.0.join("outside/images/secret.png"),
        f.0.join("work/images/leaf.png"),
    )
    .expect("native symlink security tests require Developer Mode or symlink privilege");
    for relative in ["images/link/secret.png", "images/leaf.png"] {
        assert!(access
            .read_document_image("main", grant.id, Path::new("note.md"), Path::new(relative))
            .is_err());
    }
    fs::remove_file(f.0.join("work/note.md")).unwrap();
    symlink_file(f.0.join("outside/secret.md"), f.0.join("work/note.md"))
        .expect("native symlink security tests require Developer Mode or symlink privilege");
    assert!(access
        .validate_image_document("main", grant.id, Path::new("note.md"))
        .is_err());
    assert_eq!(
        fs::read(f.0.join("outside/images/secret.png")).unwrap(),
        b"secret"
    );
}
