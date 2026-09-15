use super::{
    writer::{Backend, Writer},
    *,
};
use crate::resources::{
    journal_replay::{replay_metadata, ReplayStatus},
    transaction::{tests::record, Stage},
};
use std::io;
#[derive(Default)]
struct Fake {
    bytes: Vec<u8>,
    max_write: usize,
    fail_write: bool,
    fail_after_writes: Option<usize>,
    interrupt_on_write: Option<usize>,
    writes: usize,
    fail_flush: bool,
    flushes: usize,
}
impl Backend for Fake {
    fn extent(&mut self) -> io::Result<u64> {
        Ok(self.bytes.len() as u64)
    }
    fn write(&mut self, offset: u64, bytes: &[u8]) -> io::Result<usize> {
        let call = self.writes;
        self.writes += 1;
        assert_eq!(offset as usize, self.bytes.len());
        if self.interrupt_on_write == Some(call) {
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        if self.fail_write || self.fail_after_writes.is_some_and(|limit| call >= limit) {
            return Err(io::Error::from_raw_os_error(28));
        }
        let n = bytes.len().min(self.max_write);
        self.bytes.extend_from_slice(&bytes[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.flushes += 1;
        if self.fail_flush {
            Err(io::Error::other("flush"))
        } else {
            Ok(())
        }
    }
}
fn writer() -> Writer<Fake> {
    Writer::fresh(Fake {
        max_write: 7,
        ..Default::default()
    })
}
#[test]
fn short_writes_flush_once_and_replay_exact_records() {
    let mut w = writer();
    let mut r = record(0);
    let ack = w.append(&r).unwrap();
    assert_eq!(ack.sequence, 1);
    assert_eq!(
        ack.snapshots,
        super::super::journal_replay::SnapshotVerification::Unverified
    );
    assert_eq!(ack.namespace, NamespaceDurability::Unestablished);
    r.advance(Stage::AssetDurable).unwrap();
    w.append(&r).unwrap();
    let h = replay_metadata(&w.backend.bytes);
    assert_eq!(h.status(), ReplayStatus::CompletePrefix);
    assert_eq!(h.last_sequence(), 2);
    assert_eq!(h.records().next(), Some(&r));
    assert_eq!(w.backend.flushes, 2);
}
#[test]
fn invalid_transition_leaves_bytes_and_writer_usable() {
    let mut w = writer();
    let mut r = record(0);
    w.append(&r).unwrap();
    let old = w.backend.bytes.clone();
    assert_eq!(w.append(&r), Err(StoreError::InvalidRecord));
    assert_eq!(old, w.backend.bytes);
    r.advance(Stage::AssetDurable).unwrap();
    assert!(w.append(&r).is_ok());
}
#[test]
fn failed_write_and_zero_write_poison_without_acknowledgement() {
    for fail in [true, false] {
        let mut w = writer();
        w.backend.fail_write = fail;
        w.backend.max_write = 0;
        assert!(matches!(
            w.append(&record(0)),
            Err(StoreError::WriteUncertain { .. })
        ));
        assert_eq!(w.append(&record(0)), Err(StoreError::Poisoned));
        assert_eq!(w.backend.flushes, 0);
    }
}
#[test]
fn flush_failure_keeps_unacknowledged_bytes_and_poisoned_writer() {
    let mut w = writer();
    w.backend.fail_flush = true;
    assert!(matches!(
        w.append(&record(0)),
        Err(StoreError::FlushUncertain { .. })
    ));
    assert_eq!(replay_metadata(&w.backend.bytes).last_sequence(), 1);
    assert_eq!(w.append(&record(0)), Err(StoreError::Poisoned));
}
#[test]
fn external_extent_change_is_never_overwritten() {
    let mut w = writer();
    w.backend.bytes.push(42);
    assert_eq!(
        w.append(&record(0)),
        Err(StoreError::Unsafe {
            reason: Policy::Changed
        })
    );
    assert_eq!(w.backend.bytes, [42]);
    assert_eq!(w.append(&record(0)), Err(StoreError::Poisoned));
}

#[test]
fn complete_suffix_loss_cannot_be_promoted_to_recovery() {
    let mut w = writer();
    let mut r = record(0);
    let first = w.append(&r).unwrap();
    r.advance(Stage::AssetDurable).unwrap();
    w.append(&r).unwrap();
    let h = replay_metadata(&w.backend.bytes[..first.end_offset as usize]);
    assert_eq!(h.status(), ReplayStatus::CompletePrefix);
    assert_eq!(
        h.snapshots(),
        super::super::journal_replay::SnapshotVerification::Unverified
    );
}
#[test]
fn exact_partial_tail_remains_observation_and_is_never_repaired() {
    let mut w = writer();
    let mut r = record(0);
    let first = w.append(&r).unwrap();
    r.advance(Stage::AssetDurable).unwrap();
    w.backend.fail_flush = true;
    w.append(&r).unwrap_err();
    for cut in [1, 20, 60] {
        let bytes = &w.backend.bytes[..first.end_offset as usize + cut];
        assert_eq!(
            replay_metadata(bytes).status(),
            ReplayStatus::IncompleteTail
        );
    }
}

#[test]
fn failure_after_first_short_write_keeps_exact_prefix_and_poisoned_writer() {
    let mut w = writer();
    w.backend.fail_after_writes = Some(1);
    let r = record(0);
    let expected = crate::resources::journal_frame::encode_frame(1, &r).unwrap();
    assert_eq!(
        w.append(&r),
        Err(StoreError::WriteUncertain {
            operation: Operation::Write,
            code: Some(28),
        })
    );
    assert_eq!(w.backend.bytes, expected[..7]);
    assert_eq!(w.backend.writes, 2);
    assert_eq!(w.backend.flushes, 0);
    assert_eq!(w.append(&r), Err(StoreError::Poisoned));
    assert_eq!(w.backend.bytes, expected[..7]);
    assert_eq!(w.backend.writes, 2);
    assert_eq!(w.backend.flushes, 0);
}

#[test]
fn interrupted_write_after_partial_progress_retries_same_offset_and_acknowledges_once() {
    let mut w = writer();
    w.backend.interrupt_on_write = Some(1);
    let r = record(0);
    let expected = crate::resources::journal_frame::encode_frame(1, &r).unwrap();
    let ack = w.append(&r).unwrap();
    assert_eq!(ack.sequence, 1);
    assert_eq!(ack.end_offset, expected.len() as u64);
    assert_eq!(w.backend.bytes, expected);
    assert_eq!(w.backend.writes, expected.len().div_ceil(7) + 1);
    assert_eq!(w.backend.flushes, 1);
    let history = replay_metadata(&w.backend.bytes);
    assert_eq!(history.last_sequence(), 1);
    assert_eq!(history.status(), ReplayStatus::CompletePrefix);
    assert_eq!(history.records().next(), Some(&r));
}
