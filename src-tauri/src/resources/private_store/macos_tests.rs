use super::*;
use std::io::{Read, Seek, SeekFrom, Write};

#[test]
fn actual_private_root_acl_flush_read_and_cleanup() {
    let (root, mut file) = Root::create().unwrap();
    let id = root.identifier().to_owned();
    assert!(matches!(root.open_file(), Err(StoreError::Busy)));
    file.write_all(b"synthetic-only").unwrap();
    flush_file(&file).unwrap();
    drop(file);
    let reopened = Root::existing(&id).unwrap();
    let mut content = String::new();
    reopened
        .open_file()
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "synthetic-only");
    drop(reopened);
    root.cleanup().unwrap();
    assert!(matches!(
        Root::existing(&id),
        Err(StoreError::MissingExistingStore)
    ));
}
#[test]
fn private_permission_hardlink_and_symlink_fixtures_are_rejected() {
    let (root, mut file) = Root::create().unwrap();
    file.write_all(b"sentinel").unwrap();
    flush_file(&file).unwrap();
    cv(unsafe { fchmod(file.as_raw_fd(), 0o644) }).unwrap();
    assert!(check_file(&file).is_err());
    // Only this deliberately changed synthetic fixture is restored for cleanup.
    cv(unsafe { fchmod(file.as_raw_fd(), 0o600) }).unwrap();
    cv(unsafe {
        linkat(
            root.dir.as_raw_fd(),
            c"journal.v1".as_ptr(),
            root.dir.as_raw_fd(),
            c"hard".as_ptr(),
            0,
        )
    })
    .unwrap();
    assert!(check_file(&file).is_err());
    cv(unsafe { unlinkat(root.dir.as_raw_fd(), c"hard".as_ptr(), 0) }).unwrap();
    cv(unsafe {
        symlinkat(
            c"journal.v1".as_ptr(),
            root.dir.as_raw_fd(),
            c"link".as_ptr(),
        )
    })
    .unwrap();
    let error = open_at(&root.dir, b"link", O_RDONLY, 0).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(ELOOP));
    cv(unsafe { unlinkat(root.dir.as_raw_fd(), c"link".as_ptr(), 0) }).unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut content = String::new();
    file.read_to_string(&mut content).unwrap();
    assert_eq!(content, "sentinel");
    drop(file);
    root.cleanup().unwrap();
}
#[test]
fn nonexistent_and_caller_path_identifiers_do_not_create_stores() {
    assert!(matches!(
        Root::existing("../other"),
        Err(StoreError::Unsafe {
            reason: Policy::Identity
        })
    ));
    assert!(matches!(
        Root::existing(&uuid::Uuid::new_v4().to_string()),
        Err(StoreError::MissingExistingStore)
    ));
}
#[test]
fn replacement_journal_does_not_pass_retained_identity_check() {
    let (root, file) = Root::create().unwrap();
    drop(file);
    cv(unsafe {
        renameat(
            root.dir.as_raw_fd(),
            c"journal.v1".as_ptr(),
            root.dir.as_raw_fd(),
            c"original".as_ptr(),
        )
    })
    .unwrap();
    let replacement = open_at(&root.dir, b"journal.v1", O_RDWR | O_CREAT | O_EXCL, 0o600).unwrap();
    assert!(matches!(
        root.open_file(),
        Err(StoreError::Unsafe {
            reason: Policy::Changed
        })
    ));
    drop(replacement);
    cv(unsafe { unlinkat(root.dir.as_raw_fd(), c"journal.v1".as_ptr(), 0) }).unwrap();
    cv(unsafe {
        renameat(
            root.dir.as_raw_fd(),
            c"original".as_ptr(),
            root.dir.as_raw_fd(),
            c"journal.v1".as_ptr(),
        )
    })
    .unwrap();
    root.cleanup().unwrap();
}

#[test]
fn fifo_replacement_is_rejected_without_waiting_for_a_writer() {
    let (root, file) = Root::create().unwrap();
    drop(file);
    cv(unsafe {
        renameat(
            root.dir.as_raw_fd(),
            c"journal.v1".as_ptr(),
            root.dir.as_raw_fd(),
            c"original".as_ptr(),
        )
    })
    .unwrap();
    cv(unsafe { mkfifoat(root.dir.as_raw_fd(), c"journal.v1".as_ptr(), 0o600) }).unwrap();
    assert!(matches!(
        root.open_file(),
        Err(StoreError::Unsafe {
            reason: Policy::Permissions
        })
    ));
    cv(unsafe { unlinkat(root.dir.as_raw_fd(), c"journal.v1".as_ptr(), 0) }).unwrap();
    cv(unsafe {
        renameat(
            root.dir.as_raw_fd(),
            c"original".as_ptr(),
            root.dir.as_raw_fd(),
            c"journal.v1".as_ptr(),
        )
    })
    .unwrap();
    root.cleanup().unwrap();
}
