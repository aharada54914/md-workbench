use super::*;
use std::fs;

#[test]
fn directory_creation_requires_workspace_write_and_is_exclusive() {
    let root = std::env::temp_dir().join(format!("mdw-mkdir-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut access = FileAccess::default();
    access.register_window("main").unwrap();
    access.register_window("window-1").unwrap();
    let read = access
        .grant_directory_from_native_selection("main", &root, GrantKind::Workspace, Rights::READ)
        .unwrap();
    assert!(matches!(
        access.create_directory("main", read.id, Path::new("child")),
        Err(AccessError::Denied)
    ));
    let resource = access
        .grant_directory_from_native_selection("main", &root, GrantKind::Resource, Rights::WRITE)
        .unwrap();
    assert!(matches!(
        access.create_directory("main", resource.id, Path::new("child")),
        Err(AccessError::InvalidKind)
    ));
    let write = access
        .grant_directory_from_native_selection("main", &root, GrantKind::Workspace, Rights::WRITE)
        .unwrap();
    assert!(matches!(
        access.create_directory("window-1", write.id, Path::new("child")),
        Err(AccessError::Denied)
    ));
    for path in [
        "",
        "../escape",
        "a/./b",
        "a//b",
        "a:stream",
        "CON",
        "LPT².txt",
        "a\\b",
    ] {
        assert!(
            matches!(
                access.create_directory("main", write.id, Path::new(path)),
                Err(AccessError::InvalidPath)
            ),
            "{path}"
        );
    }
    access
        .create_directory("main", write.id, Path::new("child"))
        .unwrap();
    fs::write(root.join("child/keep"), b"keep").unwrap();
    assert!(
        matches!(access.create_directory("main", write.id, Path::new("child")), Err(AccessError::Io(error)) if error.kind() == io::ErrorKind::AlreadyExists)
    );
    assert_eq!(fs::read(root.join("child/keep")).unwrap(), b"keep");
    access
        .create_directory("main", write.id, Path::new("child/nested"))
        .unwrap();
    access.revoke_window("main");
    assert!(matches!(
        access.create_directory("main", write.id, Path::new("revoked")),
        Err(AccessError::Denied)
    ));
    drop(access);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn a_replaced_intermediate_directory_cannot_redirect_creation() {
    use std::os::unix::fs::symlink;
    let root = std::env::temp_dir().join(format!("mdw-mkdir-parent-{}", Uuid::new_v4()));
    fs::create_dir_all(root.join("work/parent")).unwrap();
    fs::create_dir(root.join("outside")).unwrap();
    let mut access = FileAccess::default();
    access.register_window("main").unwrap();
    let grant = access
        .grant_directory_from_native_selection(
            "main",
            &root.join("work"),
            GrantKind::Workspace,
            Rights::WRITE,
        )
        .unwrap();
    // Simulate substitution after the nofollow parent walk and before mkdir.
    let (parent, name) = resolve_parent(
        &access.get("main", grant.id, Rights::WRITE).unwrap().anchor,
        Path::new("parent/child"),
    )
    .unwrap();
    fs::rename(root.join("work/parent"), root.join("held-parent")).unwrap();
    symlink(root.join("outside"), root.join("work/parent")).unwrap();
    parent.create_dir(name).unwrap();
    assert!(root.join("held-parent/child").is_dir());
    assert!(!root.join("outside/child").exists());
    assert!(access
        .create_directory("main", grant.id, Path::new("parent/second"))
        .is_err());
    fs::remove_dir_all(root).unwrap();
}
