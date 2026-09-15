//! Windows no-replace rename using an opened source and retained destination.
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions, OpenOptionsExt};
use std::ffi::OsStr;
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::AsRawHandle;
use windows_sys::Wdk::Storage::FileSystem::{
    FileRenameInformation, NtSetInformationFile, FILE_RENAME_INFORMATION,
};
use windows_sys::Win32::Foundation::{RtlNtStatusToDosError, NTSTATUS, STATUS_SUCCESS};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

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
    // cap-std 4.0.3 CreateFileAtW adds SYNCHRONIZE and, because OVERLAPPED
    // is absent, FILE_SYNCHRONOUS_IO_NONALERT. The native rename therefore
    // completes synchronously before its stack IO_STATUS_BLOCK is released.
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
    // u8 storage would not guarantee FILE_RENAME_INFORMATION's pointer alignment.
    words: Vec<usize>,
    byte_len: u32,
}

impl RenameBuffer {
    fn new(target_parent: &Dir, target_name: &OsStr) -> io::Result<Self> {
        let name = encode_leaf(target_name)?;
        let name_bytes = name.len() * size_of::<u16>();
        let name_offset = offset_of!(FILE_RENAME_INFORMATION, FileName);
        // Include a zero terminator for API implementations that inspect it,
        // but FileNameLength is bytes excluding that terminator.
        let byte_len =
            (name_offset + name_bytes + size_of::<u16>()).max(size_of::<FILE_RENAME_INFORMATION>());
        let mut buffer = Self {
            words: vec![0; byte_len.div_ceil(size_of::<usize>())],
            byte_len: u32::try_from(byte_len).map_err(|_| invalid_name())?,
        };
        // SAFETY: words is pointer-aligned, zero initialized, and large enough
        // for the SDK header plus the bounded UTF-16 payload and terminator.
        // Both pointer writes stay within this allocation. No Rust reference
        // to a variable-length struct or its one-element array is constructed.
        unsafe {
            let header = buffer.words.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
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
    let mut completion = IO_STATUS_BLOCK::default();
    // SAFETY: source comes only from open_source, with DELETE access and
    // synchronous IO (no OVERLAPPED). Both handles, the aligned SDK buffer and
    // completion remain alive until the kernel completes this call. Native
    // FileRenameInformation resolves the basename against RootDirectory;
    // no Win32 path translation or process current-directory lookup occurs.
    let status = unsafe {
        NtSetInformationFile(
            source.as_raw_handle(),
            &mut completion,
            buffer.words.as_ptr().cast(),
            buffer.byte_len,
            FileRenameInformation,
        )
    };
    rename_status(status)
}

fn rename_status(status: NTSTATUS) -> io::Result<()> {
    // Require completed success, not NT_SUCCESS(status): STATUS_PENDING is
    // nonnegative but must never be reported as a completed rename. Our
    // synchronous source handle prevents that asynchronous return in practice.
    if status == STATUS_SUCCESS {
        Ok(())
    } else {
        // Native calls do not set GetLastError. Preserve the translated native
        // failure (including collision); never retry with weaker semantics.
        Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ))
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
