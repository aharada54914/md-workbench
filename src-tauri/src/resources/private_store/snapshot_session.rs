//! Host-only one-document snapshot session. No stage advancement or reopened writer.
use super::super::{
    snapshot,
    snapshot_write::{self, Backend, SnapshotStoreError},
    VerifiedDocumentSnapshotBytes,
};
use super::*;
use crate::resources::{journal_replay::ReplayStatus, transaction::Stage};
pub struct SnapshotSession {
    owner: PrivateSession,
    observation: AppendObservation,
}
pub struct SnapshotFailure {
    pub error: SnapshotStoreError,
    pub owner: Option<PrivateSession>,
}
impl SnapshotSession {
    /// Inputs are checked before creating any native object. Bootstrap failures have
    /// the same explicit residual-storage limitation as FreshJournalWriter::create.
    pub fn create(
        record: &JournalRecord,
        before: Option<&[u8]>,
        after: &[u8],
    ) -> Result<Self, SnapshotFailure> {
        snapshot::validate_input(record, before, after).map_err(|e| SnapshotFailure {
            error: e.into(),
            owner: None,
        })?;
        let mut writer = FreshJournalWriter::create().map_err(|e| SnapshotFailure {
            error: e.into(),
            owner: None,
        })?;
        let result = (|| {
            let header =
                snapshot::encode_header(writer.session.identifier(), record, before, after)?;
            #[cfg(feature = "private-store-probe")]
            super::super::probe::notify(
                super::super::probe::Boundary::BeforeSnapshot,
                Some(writer.session.identifier()),
            );
            let file = writer.session.root.create_snapshot(record.id())?;
            let mut backend = NativeSnapshot {
                file,
                writer: &mut writer,
                record,
                offset: 0,
            };
            snapshot_write::execute(&mut backend, &header, before, after)
        })();
        let owner = writer.close();
        match result {
            Ok(observation) => Ok(Self { owner, observation }),
            Err(error) => Err(SnapshotFailure {
                error,
                owner: Some(owner),
            }),
        }
    }
    pub fn observation(&self) -> AppendObservation {
        self.observation
    }
    pub fn identifier(&self) -> &str {
        self.owner.identifier()
    }
    pub fn close(self) -> PrivateSession {
        self.owner
    }
}
struct NativeSnapshot<'a> {
    file: File,
    writer: &'a mut FreshJournalWriter,
    record: &'a JournalRecord,
    offset: u64,
}
impl Backend for NativeSnapshot<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        #[cfg(feature = "private-store-probe")]
        let bytes = &bytes[..super::super::probe::write_limit(self.offset, bytes.len())];
        let n = self.file.write(bytes)?;
        self.offset += n as u64;
        #[cfg(feature = "private-store-probe")]
        if self.offset == super::super::probe::FIRST_FRAGMENT as u64 {
            super::super::probe::notify(
                super::super::probe::Boundary::PartialSnapshot,
                Some(self.writer.session.identifier()),
            );
        }
        Ok(n)
    }
    fn flush_file(&mut self) -> Result<(), StoreError> {
        native::flush_file(&self.file).map_err(|e| StoreError::FlushUncertain {
            operation: Operation::FlushFile,
            code: e.raw_os_error(),
        })
    }
    fn flush_root(&mut self) -> Result<(), StoreError> {
        self.writer.session.root.flush_snapshot_root()?;
        #[cfg(feature = "private-store-probe")]
        super::super::probe::notify(
            super::super::probe::Boundary::SnapshotFlushed,
            Some(self.writer.session.identifier()),
        );
        Ok(())
    }
    fn verify(&mut self) -> Result<(), SnapshotStoreError> {
        native::check_file(&self.file).map_err(|e| StoreError::io(Operation::InspectFile, e))?;
        let extent = self
            .file
            .metadata()
            .map_err(|e| StoreError::io(Operation::Read, e))?
            .len();
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|e| StoreError::io(Operation::Seek, e))?;
        snapshot::verify(
            &mut self.file,
            extent,
            self.writer.session.identifier(),
            self.record,
        )?;
        Ok(())
    }
    fn prepared(&mut self) -> Result<AppendObservation, StoreError> {
        let ack = self.writer.append(self.record)?;
        #[cfg(feature = "private-store-probe")]
        super::super::probe::notify(
            super::super::probe::Boundary::SnapshotPrepared,
            Some(self.writer.session.identifier()),
        );
        Ok(ack)
    }
}
impl PrivateSession {
    /// Independent read-only inspection. Verified bytes confer neither recovery nor
    /// destination authority. A complete EOF does not prove absence of lost suffixes.
    pub fn inspect_document_snapshot(
        identifier: &str,
    ) -> Result<VerifiedDocumentSnapshotBytes, SnapshotStoreError> {
        let root = native::Root::existing(identifier)?;
        let history = read(root.open_file()?)?;
        let mut records = history.records();
        let record = records.next().ok_or(SnapshotStoreError::UnboundHistory)?;
        if history.status() != ReplayStatus::CompletePrefix
            || history.last_sequence() != 1
            || records.next().is_some()
            || record.stage() != Stage::Prepared
            || !record.assets().is_empty()
        {
            return Err(SnapshotStoreError::UnboundHistory);
        }
        let mut file = root.open_snapshot(record.id())?;
        let extent = file
            .metadata()
            .map_err(|e| StoreError::io(Operation::Read, e))?
            .len();
        Ok(snapshot::verify(&mut file, extent, identifier, record)?)
    }
}

#[cfg(test)]
#[path = "snapshot_session_tests.rs"]
mod tests;

#[cfg(feature = "private-store-probe")]
impl PrivateSession {
    pub fn probe_snapshot_matches(
        identifier: &str,
        transaction: &crate::resources::transaction::TransactionId,
        expected: Option<&[u8]>,
    ) -> Result<bool, StoreError> {
        let root = native::Root::existing(identifier)?;
        let mut file = match root.open_snapshot(transaction) {
            Ok(file) => file,
            Err(StoreError::MissingExistingStore) => return Ok(expected.is_none()),
            Err(e) => return Err(e),
        };
        let Some(expected) = expected else {
            return Ok(false);
        };
        if expected.len() as u64 > snapshot::MAX_BUNDLE {
            return Err(StoreError::LimitExceeded);
        };
        let mut bytes = Vec::new();
        (&mut file)
            .take(expected.len() as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| StoreError::io(Operation::Read, e))?;
        Ok(bytes == expected)
    }
}
