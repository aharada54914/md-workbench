//! Windows no-replace rename using an opened source and retained destination.
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions, OpenOptionsExt};
use std::ffi::OsStr;
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Storage::FileSystem::{
    FileRenameInfo, SetFileInformationByHandle, DELETE, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    FILE_RENAME_INFO, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

// Windows filesystem component limit, expressed in UTF-16 code units.
const MAX_NAME_UNITS: usize = 255;

fn invalid_name() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid rename basename")
}

/// The core validates portable names; also guard this FFI boundary against
/// paths/streams or unbounded input if a later caller bypasses that core.
fn encode_leaf(name: &OsStr) -> io::Result<Vec<u16>> {
    let units: Vec<u16> = name.encode_wide().take(MAX_NAME_UNITS + 1).collect();
    if units.is_empty()
        || units.len() > MAX_NAME_UNITS
        || units == [b'.' as u16]
        || units == [b'.' as u16, b'.' as u16]
        || units
            .iter()
            .any(|unit| *unit < 32 || matches!(*unit, 34 | 42 | 47 | 58 | 60 | 62 | 63 | 92 | 124))
        || matches!(units.last(), Some(32 | 46))
    {
        return Err(invalid_name());
    }
    Ok(units)
}

fn open_source(parent: &Dir, name: &OsStr) -> io::Result<std::fs::File> {
    encode_leaf(name)?;
    let mut options = OpenOptions::new();
    options
        .access_mode(DELETE | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        // BACKUP_SEMANTICS permits a directory without taking an additional
        // cap directory handle that would block its own rename. No truncation.
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .follow(FollowSymlinks::No);
    // cap-std opens this single leaf relative to the parent's native handle.
    let source = parent.open_with(name, &options)?.into_std();
    let metadata = source.metadata()?;
    // Inspect the opened object, not a second path lookup. Reject every
    // reparse type, including junctions, even when it looks like a directory.
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (!metadata.is_file() && !metadata.is_dir())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "rename source must be a regular file or directory",
        ));
    }
    Ok(source)
}

struct RenameBuffer {
    // u8 storage would not guarantee FILE_RENAME_INFO's pointer alignment.
    words: Vec<usize>,
    byte_len: u32,
}

impl RenameBuffer {
    fn new(target_parent: &Dir, target_name: &OsStr) -> io::Result<Self> {
        let name = encode_leaf(target_name)?;
        let name_bytes = name.len() * size_of::<u16>();
        let name_offset = offset_of!(FILE_RENAME_INFO, FileName);
        // Include a zero terminator for API implementations that inspect it,
        // but FileNameLength is bytes excluding that terminator.
        let byte_len =
            (name_offset + name_bytes + size_of::<u16>()).max(size_of::<FILE_RENAME_INFO>());
        let mut buffer = Self {
            words: vec![0; byte_len.div_ceil(size_of::<usize>())],
            byte_len: u32::try_from(byte_len).map_err(|_| invalid_name())?,
        };
        // SAFETY: words is pointer-aligned, zero initialized, and large enough
        // for the SDK header plus the bounded UTF-16 payload and terminator.
        // Both pointer writes stay within this allocation. No Rust reference
        // to a variable-length struct or its one-element array is constructed.
        unsafe {
            let header = buffer.words.as_mut_ptr().cast::<FILE_RENAME_INFO>();
            (*header).Anonymous.ReplaceIfExists = false;
            (*header).RootDirectory = target_parent.as_raw_handle();
            (*header).FileNameLength = name_bytes as u32;
            let payload = buffer
                .words
                .as_mut_ptr()
                .cast::<u8>()
                .add(name_offset)
                .cast::<u16>();
            std::ptr::copy_nonoverlapping(name.as_ptr(), payload, name.len());
        }
        Ok(buffer)
    }
}

fn rename_open_source(
    source: &std::fs::File,
    target_parent: &Dir,
    target_name: &OsStr,
) -> io::Result<()> {
    let buffer = RenameBuffer::new(target_parent, target_name)?;
    // SAFETY: the source has DELETE access; source, target parent and aligned
    // buffer remain alive throughout this synchronous call. The buffer uses
    // the SDK layout and contains only a basename relative to target_parent.
    let result = unsafe {
        SetFileInformationByHandle(
            source.as_raw_handle(),
            FileRenameInfo,
            buffer.words.as_ptr().cast(),
            buffer.byte_len,
        )
    };
    if result == 0 {
        // Preserve the OS failure, including destination collision. Never
        // retry with replacement, ambient paths, or copy/unlink semantics.
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(super) fn rename_no_replace(
    source_parent: &Dir,
    source_name: &OsStr,
    target_parent: &Dir,
    target_name: &OsStr,
) -> io::Result<()> {
    encode_leaf(target_name)?;
    let source = open_source(source_parent, source_name)?;
    rename_open_source(&source, target_parent, target_name)
}

#[cfg(test)]
#[path = "file_access_rename_windows_tests.rs"]
mod tests;
