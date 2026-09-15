use super::super::{
    journal_frame::encode_frame,
    journal_replay::{
        valid_progress, SnapshotVerification, MAX_HISTORY_BYTES, MAX_HISTORY_FRAMES,
        MAX_HISTORY_TRANSACTIONS,
    },
    transaction::JournalRecord,
};
use super::{AppendObservation, NamespaceDurability, Operation, StoreError};
use std::{collections::BTreeMap, io};

// Only native fresh creation constructs this backend in product code.
pub(super) trait Backend {
    fn extent(&mut self) -> io::Result<u64>;
    fn write(&mut self, offset: u64, bytes: &[u8]) -> io::Result<usize>;
    fn flush(&mut self) -> io::Result<()>;
}
pub(super) struct Writer<B> {
    pub(super) backend: B,
    latest: BTreeMap<String, JournalRecord>,
    frames: usize,
    extent: u64,
    poisoned: bool,
}
impl<B: Backend> Writer<B> {
    pub(super) fn fresh(backend: B) -> Self {
        Self {
            backend,
            latest: BTreeMap::new(),
            frames: 0,
            extent: 0,
            poisoned: false,
        }
    }
    pub(super) fn append(
        &mut self,
        record: &JournalRecord,
    ) -> Result<AppendObservation, StoreError> {
        if self.poisoned {
            return Err(StoreError::Poisoned);
        }
        let prior = self.latest.get(record.id().as_str());
        if self.frames == MAX_HISTORY_FRAMES
            || (prior.is_none() && self.latest.len() == MAX_HISTORY_TRANSACTIONS)
        {
            return Err(StoreError::LimitExceeded);
        }
        if !valid_progress(prior, record) {
            return Err(StoreError::InvalidRecord);
        }
        let sequence = (self.frames as u64)
            .checked_add(1)
            .ok_or(StoreError::LimitExceeded)?;
        let bytes = encode_frame(sequence, record).map_err(|_| StoreError::InvalidRecord)?;
        let end = self
            .extent
            .checked_add(bytes.len() as u64)
            .filter(|&n| n <= MAX_HISTORY_BYTES as u64)
            .ok_or(StoreError::LimitExceeded)?;
        let actual = self
            .backend
            .extent()
            .map_err(|e| StoreError::io(Operation::Inspect, e))?;
        if actual != self.extent {
            self.poisoned = true;
            return Err(StoreError::Unsafe {
                reason: super::Policy::Changed,
            });
        }
        // Validate and clone before I/O. Index allocation after flush can still
        // abort on OOM; only the returned observation acknowledges this append.
        let key = record.id().as_str().to_owned();
        let candidate = record.clone();
        let mut written = 0;
        while written < bytes.len() {
            match self
                .backend
                .write(self.extent + written as u64, &bytes[written..])
            {
                Ok(n) if n > 0 && n <= bytes.len() - written => {
                    written += n;
                    #[cfg(feature = "private-store-probe")]
                    if written == super::probe::FIRST_FRAGMENT && written < bytes.len() {
                        super::probe::notify(super::probe::Boundary::PartialAppend, None);
                    }
                }
                Ok(_) => {
                    self.poisoned = true;
                    return Err(StoreError::WriteUncertain {
                        operation: Operation::Write,
                        code: None,
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    self.poisoned = true;
                    return Err(StoreError::WriteUncertain {
                        operation: Operation::Write,
                        code: e.raw_os_error(),
                    });
                }
            }
        }
        if let Err(e) = self.backend.flush() {
            self.poisoned = true;
            return Err(StoreError::FlushUncertain {
                operation: Operation::FlushFile,
                code: e.raw_os_error(),
            });
        }
        #[cfg(feature = "private-store-probe")]
        super::probe::notify(super::probe::Boundary::FlushedBeforeAck, None);
        self.extent = end;
        self.frames += 1;
        self.latest.insert(key, candidate);
        Ok(AppendObservation {
            sequence,
            end_offset: end,
            namespace: NamespaceDurability::Unestablished,
            snapshots: SnapshotVerification::Unverified,
        })
    }
}
