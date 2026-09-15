use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

struct TempRoot(PathBuf);
impl TempRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("mdw-rename-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn dir(&self, relative: &str) -> Dir {
        Dir::open_ambient_dir(self.0.join(relative), cap_std::ambient_authority()).unwrap()
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn rename(from: &Dir, name: &str, to: &Dir, new_name: &str) -> io::Result<()> {
    rename_no_replace(from, OsStr::new(name), to, OsStr::new(new_name))
}
fn junction(link: &Path, target: &Path) {
    let result = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(result.status.success(), "junction fixture: {:?}", result);
}

#[test]
fn windows_rename_file_same_parent_preserves_bytes_and_unicode() {
    let root = TempRoot::new();
    let bytes = b"\xef\xbb\xbf# source\r\n\r\n";
    fs::write(root.0.join("source.md"), bytes).unwrap();
    let parent = root.dir("");
    rename(&parent, "source.md", &parent, "renamed-文書-🦀.md").unwrap();
    assert!(!root.0.join("source.md").exists());
    assert_eq!(fs::read(root.0.join("renamed-文書-🦀.md")).unwrap(), bytes);
}

#[test]
fn windows_rename_files_and_directories_across_parents() {
    let root = TempRoot::new();
    fs::create_dir(root.0.join("a")).unwrap();
    fs::create_dir(root.0.join("b")).unwrap();
    fs::create_dir(root.0.join("a/tree")).unwrap();
    fs::write(root.0.join("a/tree/content.md"), "nested").unwrap();
    fs::write(root.0.join("a/file.md"), "file").unwrap();
    let a = root.dir("a");
    let b = root.dir("b");
    rename(&a, "file.md", &b, "moved.md").unwrap();
    rename(&a, "tree", &b, "moved-tree").unwrap();
    rename(&b, "moved-tree", &b, "renamed-tree").unwrap();
    assert_eq!(fs::read(root.0.join("b/moved.md")).unwrap(), b"file");
    assert_eq!(
        fs::read(root.0.join("b/renamed-tree/content.md")).unwrap(),
        b"nested"
    );
    assert!(!root.0.join("a/tree").exists());
}

#[test]
fn windows_rename_never_replaces_existing_file_or_directory() {
    for source_directory in [false, true] {
        for target_directory in [false, true] {
            let root = TempRoot::new();
            if source_directory {
                fs::create_dir(root.0.join("source")).unwrap();
                fs::write(root.0.join("source/child"), b"source").unwrap();
            } else {
                fs::write(root.0.join("source"), b"source").unwrap();
            }
            if target_directory {
                fs::create_dir(root.0.join("target")).unwrap();
            } else {
                fs::write(root.0.join("target"), b"target").unwrap();
            }
            let parent = root.dir("");
            assert!(rename(&parent, "source", &parent, "target").is_err());
            let source = if source_directory {
                "source/child"
            } else {
                "source"
            };
            assert_eq!(fs::read(root.0.join(source)).unwrap(), b"source");
            if target_directory {
                assert_eq!(fs::read_dir(root.0.join("target")).unwrap().count(), 0);
            } else {
                assert_eq!(fs::read(root.0.join("target")).unwrap(), b"target");
            }
        }
    }
}

#[test]
fn windows_rename_rejects_destination_created_after_source_open() {
    let root = TempRoot::new();
    fs::write(root.0.join("source"), b"source").unwrap();
    let parent = root.dir("");
    let source = open_source(&parent, OsStr::new("source")).unwrap();
    // Deterministic publication race: destination appears only after source
    // acquisition, immediately before the actual rename syscall.
    fs::write(root.0.join("target"), b"concurrent").unwrap();
    assert!(rename_open_source(&source, &parent, OsStr::new("target")).is_err());
    assert_eq!(fs::read(root.0.join("source")).unwrap(), b"source");
    assert_eq!(fs::read(root.0.join("target")).unwrap(), b"concurrent");
}

#[test]
fn windows_rename_preserves_dangling_destination_link() {
    let root = TempRoot::new();
    fs::write(root.0.join("source"), b"source").unwrap();
    std::os::windows::fs::symlink_file("missing", root.0.join("target"))
        .expect("Windows CI needs symlink creation privilege for this security regression");
    let parent = root.dir("");
    assert!(rename(&parent, "source", &parent, "target").is_err());
    assert_eq!(
        fs::read_link(root.0.join("target")).unwrap(),
        PathBuf::from("missing")
    );
    assert_eq!(fs::read(root.0.join("source")).unwrap(), b"source");
    assert!(!root.0.join("missing").exists());
}

#[test]
fn windows_rename_rejects_source_junction_without_touching_target() {
    let root = TempRoot::new();
    let outside = TempRoot::new();
    fs::write(outside.0.join("sentinel"), b"outside").unwrap();
    junction(&root.0.join("junction"), &outside.0);
    let parent = root.dir("");
    assert!(rename(&parent, "junction", &parent, "new-name").is_err());
    assert!(!root.0.join("new-name").exists());
    assert_eq!(fs::read(outside.0.join("sentinel")).unwrap(), b"outside");
    assert!(fs::symlink_metadata(root.0.join("junction")).is_ok());
    fs::remove_dir(root.0.join("junction")).unwrap();
}

#[test]
fn windows_retained_parent_cannot_be_replaced_during_rename() {
    let root = TempRoot::new();
    fs::create_dir(root.0.join("parent")).unwrap();
    fs::write(root.0.join("parent/source"), b"source").unwrap();
    let parent = root.dir("parent");
    // cap's no-DELETE-sharing directory handle prevents swapping the parent
    // out for a junction between resolution and publication.
    assert!(fs::rename(root.0.join("parent"), root.0.join("moved")).is_err());
    rename(&parent, "source", &parent, "target").unwrap();
    assert_eq!(fs::read(root.0.join("parent/target")).unwrap(), b"source");
}

#[test]
fn windows_os_sharing_failure_never_falls_back_to_path_rename() {
    use std::os::windows::fs::OpenOptionsExt as _;
    let root = TempRoot::new();
    fs::write(root.0.join("source"), b"source").unwrap();
    let parent = root.dir("");
    let _busy = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(root.0.join("source"))
        .unwrap();
    assert!(rename(&parent, "source", &parent, "target").is_err());
    assert!(root.0.join("source").exists());
    assert!(!root.0.join("target").exists());
}

#[test]
fn windows_rename_buffer_matches_sdk_layout_alignment_and_utf16_length() {
    let root = TempRoot::new();
    let parent = root.dir("");
    let buffer = RenameBuffer::new(&parent, OsStr::new("文書-🦀.md")).unwrap();
    let expected: Vec<u16> = OsStr::new("文書-🦀.md").encode_wide().collect();
    assert_eq!(
        buffer.words.as_ptr() as usize % std::mem::align_of::<FILE_RENAME_INFORMATION>(),
        0
    );
    // SAFETY: inspecting the same initialized/aligned allocation passed to FFI.
    unsafe {
        let header = &*buffer.words.as_ptr().cast::<FILE_RENAME_INFORMATION>();
        assert!(!header.Anonymous.ReplaceIfExists);
        assert_eq!(header.RootDirectory, parent.as_raw_handle());
        assert_eq!(header.FileNameLength as usize, expected.len() * 2);
        let payload = buffer
            .words
            .as_ptr()
            .cast::<u8>()
            .add(offset_of!(FILE_RENAME_INFORMATION, FileName))
            .cast::<u16>();
        assert_eq!(
            std::slice::from_raw_parts(payload, expected.len()),
            expected
        );
        assert_eq!(*payload.add(expected.len()), 0);
    }
}

#[test]
fn windows_rename_rejects_nonleaf_and_excessive_names_before_io() {
    let root = TempRoot::new();
    fs::write(root.0.join("source"), b"source").unwrap();
    let parent = root.dir("");
    for invalid in [
        "",
        ".",
        "..",
        "../escape",
        "dir\\child",
        "C:drive",
        "x:ads",
        "null\0x",
        "dot.",
        "space ",
    ] {
        assert_eq!(
            rename(&parent, "source", &parent, invalid)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            rename(&parent, invalid, &parent, "target")
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
    assert!(encode_leaf(OsStr::new(&"a".repeat(MAX_NAME_UNITS))).is_ok());
    assert!(encode_leaf(OsStr::new(&"a".repeat(MAX_NAME_UNITS + 1))).is_err());
    // Astral characters consume two UTF-16 units each.
    assert!(encode_leaf(OsStr::new(&"🦀".repeat(128))).is_err());
    assert_eq!(fs::read(root.0.join("source")).unwrap(), b"source");
    assert!(!root.0.join("target").exists());
}

#[test]
fn windows_rename_rejects_source_file_symlink_and_preserves_destination_junction() {
    let root = TempRoot::new();
    let outside = TempRoot::new();
    fs::write(outside.0.join("sentinel"), b"outside").unwrap();
    fs::write(root.0.join("source"), b"source").unwrap();
    std::os::windows::fs::symlink_file(outside.0.join("sentinel"), root.0.join("link"))
        .expect("Windows CI needs symlink creation privilege for this security regression");
    junction(&root.0.join("destination-junction"), &outside.0);
    let parent = root.dir("");
    assert!(rename(&parent, "link", &parent, "new-name").is_err());
    assert!(rename(&parent, "source", &parent, "destination-junction").is_err());
    assert_eq!(fs::read(outside.0.join("sentinel")).unwrap(), b"outside");
    assert_eq!(fs::read(root.0.join("source")).unwrap(), b"source");
    assert!(fs::read_link(root.0.join("link")).is_ok());
    assert!(!root.0.join("new-name").exists());
    fs::remove_dir(root.0.join("destination-junction")).unwrap();
}

#[test]
fn windows_native_status_preserves_collision_and_rejects_pending() {
    use windows_sys::Win32::Foundation::{
        ERROR_IO_PENDING, STATUS_OBJECT_NAME_COLLISION, STATUS_PENDING,
    };
    assert!(rename_status(STATUS_SUCCESS).is_ok());
    assert_eq!(
        rename_status(STATUS_OBJECT_NAME_COLLISION)
            .unwrap_err()
            .kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(
        rename_status(STATUS_PENDING).unwrap_err().raw_os_error(),
        Some(ERROR_IO_PENDING as i32)
    );
}

#[test]
fn windows_source_handle_is_synchronous_for_stack_io_status_lifetime() {
    use windows_sys::Wdk::Storage::FileSystem::{
        FileModeInformation, NtQueryInformationFile, FILE_MODE_INFORMATION,
        FILE_SYNCHRONOUS_IO_NONALERT,
    };
    let root = TempRoot::new();
    fs::write(root.0.join("source"), b"source").unwrap();
    let parent = root.dir("");
    let source = open_source(&parent, OsStr::new("source")).unwrap();
    let mut completion = IO_STATUS_BLOCK::default();
    let mut mode = FILE_MODE_INFORMATION::default();
    // SAFETY: the live handle and initialized fixed-size SDK output structures
    // remain valid throughout this synchronous metadata query.
    let status = unsafe {
        NtQueryInformationFile(
            source.as_raw_handle(),
            &mut completion,
            (&mut mode as *mut FILE_MODE_INFORMATION).cast(),
            size_of::<FILE_MODE_INFORMATION>() as u32,
            FileModeInformation,
        )
    };
    assert_eq!(status, STATUS_SUCCESS);
    assert_ne!(mode.Mode & FILE_SYNCHRONOUS_IO_NONALERT, 0);
}
