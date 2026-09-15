//! Inactive metadata storage. No IPC, destination authority or recovery certification.
#[cfg(target_os = "macos")]
mod macos;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) mod windows_acl;
mod writer;
#[cfg(target_os = "macos")]
use macos as native;
#[cfg(windows)]
use windows as native;
#[cfg(any(windows, target_os = "macos"))]
mod session;
#[cfg(any(windows, target_os = "macos"))]
pub use session::{FreshJournalWriter, PrivateSession};

use super::journal_replay::SnapshotVerification;
use serde::Serialize;
use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NamespaceDurability {
    Unestablished,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppendObservation {
    pub sequence: u64,
    pub end_offset: u64,
    pub namespace: NamespaceDurability,
    pub snapshots: SnapshotVerification,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    ResolveBase,
    Inspect,
    CreateRoot,
    CreateFile,
    Lock,
    Read,
    Seek,
    Write,
    FlushFile,
    FlushRoot,
    FlushParent,
    Cleanup,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    Identity,
    Filesystem,
    FileType,
    Permissions,
    Bounds,
    Changed,
    Missing,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoreError {
    Unsafe {
        reason: Policy,
    },
    Unsupported {
        reason: Policy,
    },
    Busy,
    AlreadyExists,
    MissingExistingStore,
    LimitExceeded,
    InvalidRecord,
    Io {
        operation: Operation,
        code: Option<i32>,
    },
    WriteUncertain {
        operation: Operation,
        code: Option<i32>,
    },
    FlushUncertain {
        operation: Operation,
        code: Option<i32>,
    },
    Poisoned,
}
impl StoreError {
    fn io(operation: Operation, error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::MissingExistingStore,
            io::ErrorKind::AlreadyExists => Self::AlreadyExists,
            io::ErrorKind::WouldBlock => Self::Busy,
            _ => Self::Io {
                operation,
                code: error.raw_os_error(),
            },
        }
    }
}
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for StoreError {}
