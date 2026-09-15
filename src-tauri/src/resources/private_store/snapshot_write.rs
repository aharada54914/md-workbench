//! One attempt only: no retry API survives an uncertain write/flush.
use super::{AppendObservation, Operation, SnapshotError, StoreError};
use std::io;
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum SnapshotStoreError {
    Storage(StoreError),
    Snapshot(SnapshotError),
    UnboundHistory,
}
impl From<StoreError> for SnapshotStoreError {
    fn from(v: StoreError) -> Self {
        Self::Storage(v)
    }
}
impl From<SnapshotError> for SnapshotStoreError {
    fn from(v: SnapshotError) -> Self {
        Self::Snapshot(v)
    }
}
pub(super) trait Backend {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize>;
    fn flush_file(&mut self) -> Result<(), StoreError>;
    fn flush_root(&mut self) -> Result<(), StoreError>;
    fn verify(&mut self) -> Result<(), SnapshotStoreError>;
    fn prepared(&mut self) -> Result<AppendObservation, StoreError>;
}
pub(super) fn execute(
    backend: &mut impl Backend,
    header: &[u8],
    before: Option<&[u8]>,
    after: &[u8],
) -> Result<AppendObservation, SnapshotStoreError> {
    for mut bytes in [header, before.unwrap_or_default(), after] {
        while !bytes.is_empty() {
            match backend.write(bytes) {
                Ok(n) if n > 0 && n <= bytes.len() => bytes = &bytes[n..],
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                result => {
                    return Err(StoreError::WriteUncertain {
                        operation: Operation::Write,
                        code: result.err().and_then(|e| e.raw_os_error()),
                    }
                    .into())
                }
            }
        }
    }
    backend.flush_file()?;
    backend.flush_root()?;
    backend.verify()?;
    Ok(backend.prepared()?)
}
#[cfg(test)]
#[path = "snapshot_write_tests.rs"]
mod tests;
