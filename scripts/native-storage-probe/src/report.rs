#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;

pub const MAX_JSON_BYTES: usize = 16 * 1024;
const MAX_FILESYSTEM_NAME: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    OpenTempParent,
    CreateFixture,
    OpenReadonlyDirectory,
    QueryFilesystem,
    FlushReadonlyDirectory,
    OpenReadwriteDirectory,
    CreateChildDirectory,
    OpenReadwriteChild,
    WriteFile,
    FlushFile,
    FlushChildDirectory,
    FlushParentDirectory,
    Cleanup,
}

pub const OPERATIONS: [Operation; 13] = [
    Operation::OpenTempParent,
    Operation::CreateFixture,
    Operation::OpenReadonlyDirectory,
    Operation::QueryFilesystem,
    Operation::FlushReadonlyDirectory,
    Operation::OpenReadwriteDirectory,
    Operation::CreateChildDirectory,
    Operation::OpenReadwriteChild,
    Operation::WriteFile,
    Operation::FlushFile,
    Operation::FlushChildDirectory,
    Operation::FlushParentDirectory,
    Operation::Cleanup,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    UnsupportedPlatform,
    PrerequisiteFailed,
    NonNtfs,
    UnexpectedFileType,
    InvalidFilesystemName,
    IoWithoutWin32Code,
}

impl std::fmt::Display for Reason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for Reason {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Win32Error { code: u32 },
    ProbeError { reason: Reason },
    Skipped { reason: Reason },
}

#[derive(Clone, Debug, Serialize)]
pub struct OperationResult {
    pub operation: Operation,
    pub outcome: Outcome,
}

#[derive(Clone, Debug, Serialize)]
pub struct Filesystem {
    pub filesystem_type: String,
    pub flags: u32,
    pub max_component_length: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    schema_version: u32,
    scope: &'static str,
    platform: &'static str,
    pub filesystem: Option<Filesystem>,
    // These describe the explicit directory open, not the cap-std baseline.
    directory_access: u32,
    directory_share: u32,
    directory_flags: u32,
    pub operations: Vec<OperationResult>,
}

impl Report {
    pub fn windows() -> Self {
        Self::new("windows", Reason::PrerequisiteFailed)
    }

    pub fn unsupported() -> Self {
        Self::new("unsupported", Reason::UnsupportedPlatform)
    }

    fn new(platform: &'static str, reason: Reason) -> Self {
        Self {
            schema_version: 1,
            scope: "api_support_only",
            platform,
            filesystem: None,
            directory_access: 0xc0000000, // GENERIC_READ | GENERIC_WRITE
            directory_share: 3,           // FILE_SHARE_READ | FILE_SHARE_WRITE, no DELETE
            directory_flags: 0x02200000,  // BACKUP_SEMANTICS | OPEN_REPARSE_POINT
            operations: OPERATIONS
                .iter()
                .map(|&operation| OperationResult {
                    operation,
                    outcome: Outcome::Skipped { reason },
                })
                .collect(),
        }
    }

    pub fn set(&mut self, operation: Operation, outcome: Outcome) {
        if let Some(entry) = self
            .operations
            .iter_mut()
            .find(|e| e.operation == operation)
        {
            entry.outcome = outcome;
        }
    }

    pub fn skip_remaining(&mut self, reason: Reason) {
        for entry in &mut self.operations {
            if matches!(entry.outcome, Outcome::Skipped { .. }) {
                entry.outcome = Outcome::Skipped { reason };
            }
        }
    }

    pub fn to_json(&self) -> Result<Vec<u8>, ()> {
        if self.schema_version != 1
            || self.scope != "api_support_only"
            || !matches!(self.platform, "windows" | "unsupported")
            || self.directory_access != 0xc0000000
            || self.directory_share != 3
            || self.directory_flags != 0x02200000
            || self.operations.len() != OPERATIONS.len()
            || self
                .operations
                .iter()
                .zip(OPERATIONS)
                .any(|(r, op)| r.operation != op)
        {
            return Err(());
        }
        if let Some(fs) = &self.filesystem {
            if fs.filesystem_type.is_empty()
                || fs.filesystem_type.len() > MAX_FILESYSTEM_NAME
                || !fs
                    .filesystem_type
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err(());
            }
        }
        let bytes = serde_json::to_vec(self).map_err(|_| ())?;
        if bytes.len() >= MAX_JSON_BYTES {
            return Err(());
        }
        Ok(bytes)
    }
}

#[cfg(test)]
#[path = "report_tests.rs"]
mod tests;
