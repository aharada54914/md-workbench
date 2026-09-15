use super::super::{
    journal_replay::{replay_metadata, MetadataOnlyHistory, MAX_HISTORY_BYTES},
    transaction::JournalRecord,
};
use super::{
    native,
    writer::{Backend, Writer},
    AppendObservation, Operation, StoreError,
};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
};

// Neither a path string nor reopened metadata can construct a writer.
pub struct FreshJournalWriter {
    writer: Writer<NativeFile>,
    session: PrivateSession,
}
pub struct PrivateSession {
    root: native::Root,
}
struct NativeFile(File);
impl Backend for NativeFile {
    fn extent(&mut self) -> io::Result<u64> {
        native::check_file(&self.0)?;
        Ok(self.0.metadata()?.len())
    }
    fn write(&mut self, offset: u64, bytes: &[u8]) -> io::Result<usize> {
        self.0.seek(SeekFrom::Start(offset))?;
        self.0.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        native::flush_file(&self.0)
    }
}
impl FreshJournalWriter {
    pub fn create() -> Result<Self, StoreError> {
        let (root, file) = native::Root::create()?;
        Ok(Self {
            writer: Writer::fresh(NativeFile(file)),
            session: PrivateSession { root },
        })
    }
    pub fn append(&mut self, record: &JournalRecord) -> Result<AppendObservation, StoreError> {
        self.writer.append(record)
    }
    pub fn close(self) -> PrivateSession {
        self.session
    }
}
impl PrivateSession {
    pub fn inspect(&self) -> Result<MetadataOnlyHistory, StoreError> {
        read(self.root.open_file()?)
    }
    /// Host-only identifier for diagnostics; never registered with renderer IPC.
    pub fn identifier(&self) -> &str {
        self.root.identifier()
    }
    /// Read-only and independently revalidated; never returns a writer/cleanup owner.
    pub fn inspect_existing(identifier: &str) -> Result<MetadataOnlyHistory, StoreError> {
        let root = native::Root::existing(identifier)?;
        read(root.open_file()?)
    }
    /// Only exclusive-created sessions have this ownership; never recursive.
    pub fn cleanup(self) -> Result<(), StoreError> {
        self.root.cleanup()
    }
}
fn read(mut file: File) -> Result<MetadataOnlyHistory, StoreError> {
    if file
        .metadata()
        .map_err(|e| StoreError::io(Operation::Read, e))?
        .len()
        > MAX_HISTORY_BYTES as u64
    {
        return Err(StoreError::LimitExceeded);
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_HISTORY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| StoreError::io(Operation::Read, e))?;
    if bytes.len() > MAX_HISTORY_BYTES {
        return Err(StoreError::LimitExceeded);
    }
    Ok(replay_metadata(&bytes))
}
