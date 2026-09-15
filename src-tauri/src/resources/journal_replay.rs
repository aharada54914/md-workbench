//! Bounded metadata history only: no snapshots, filesystem authority, or durability.
use super::{
    journal_frame::{decode_frame, FrameError},
    transaction::{AssetState, JournalError, JournalRecord, Stage},
};
use std::collections::BTreeMap;

pub const MAX_HISTORY_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_HISTORY_FRAMES: usize = 4096;
pub const MAX_HISTORY_TRANSACTIONS: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryError {
    Frame(FrameError),
    Sequence,
    Transition,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayStatus {
    /// EOF at a frame boundary does not prove that no accepted suffix was lost.
    CompletePrefix,
    /// Never permission to truncate or resume append: old history may be cut too.
    IncompleteTail,
    InvalidHistory(HistoryError),
    UnsupportedVersion,
    LimitExceeded,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotVerification {
    Unverified,
}

/// Cannot be promoted into a verified recovery/commit result. Records retain
/// host-reported stage labels only, even when the recorded stage is COMPLETED.
#[derive(Debug)]
pub struct MetadataOnlyHistory {
    latest: BTreeMap<String, JournalRecord>,
    validated_bytes: usize,
    last_sequence: u64,
    status: ReplayStatus,
}
impl MetadataOnlyHistory {
    pub fn records(&self) -> impl Iterator<Item = &JournalRecord> {
        self.latest.values()
    }
    pub fn validated_bytes(&self) -> usize {
        self.validated_bytes
    }
    pub fn last_sequence(&self) -> u64 {
        self.last_sequence
    }
    pub fn status(&self) -> ReplayStatus {
        self.status
    }
    pub fn snapshots(&self) -> SnapshotVerification {
        SnapshotVerification::Unverified
    }
}

pub fn replay_metadata(input: &[u8]) -> MetadataOnlyHistory {
    let mut history = MetadataOnlyHistory {
        latest: BTreeMap::new(),
        validated_bytes: 0,
        last_sequence: 0,
        status: ReplayStatus::CompletePrefix,
    };
    if input.len() > MAX_HISTORY_BYTES {
        history.status = ReplayStatus::LimitExceeded;
        return history;
    }
    let mut count = 0;
    while history.validated_bytes < input.len() {
        if count == MAX_HISTORY_FRAMES {
            history.status = ReplayStatus::LimitExceeded;
            break;
        }
        let frame = match decode_frame(&input[history.validated_bytes..]) {
            Ok(frame) => frame,
            Err(error) => {
                history.status = match error {
                    FrameError::Incomplete => ReplayStatus::IncompleteTail,
                    FrameError::UnsupportedVersion
                    | FrameError::InvalidPayload(JournalError::UnsupportedVersion) => {
                        ReplayStatus::UnsupportedVersion
                    }
                    FrameError::LimitExceeded => ReplayStatus::LimitExceeded,
                    error => ReplayStatus::InvalidHistory(HistoryError::Frame(error)),
                };
                break;
            }
        };
        if history.last_sequence.checked_add(1) != Some(frame.sequence) {
            history.status = ReplayStatus::InvalidHistory(HistoryError::Sequence);
            break;
        }
        let key = frame.record.id().as_str();
        let previous = history.latest.get(key);
        if previous.is_none() && history.latest.len() == MAX_HISTORY_TRANSACTIONS {
            history.status = ReplayStatus::LimitExceeded;
            break;
        }
        if !valid_progress(previous, &frame.record) {
            history.status = ReplayStatus::InvalidHistory(HistoryError::Transition);
            break;
        }
        // Decoder bounds consumed to the remaining input; no changes before all
        // frame/history checks pass, so failures leave a diagnostic valid prefix.
        history.validated_bytes += frame.consumed;
        history.last_sequence = frame.sequence;
        history.latest.insert(key.to_owned(), frame.record);
        count += 1;
    }
    history
}

fn valid_progress(previous: Option<&JournalRecord>, candidate: &JournalRecord) -> bool {
    let Some(previous) = previous else {
        return candidate.stage() == Stage::Prepared
            && candidate
                .assets()
                .iter()
                .all(|asset| asset.state() == AssetState::Planned);
    };
    if previous == candidate
        || previous.stage() == Stage::Completed
        || previous.id() != candidate.id()
        || previous.document() != candidate.document()
        || previous.assets().len() != candidate.assets().len()
    {
        return false;
    }
    let mut expected = previous.clone();
    for (index, (old, new)) in previous.assets().iter().zip(candidate.assets()).enumerate() {
        if old.target() != new.target() {
            return false;
        }
        if old.state() != new.state()
            && (new.state() != AssetState::Durable || expected.mark_asset_durable(index).is_err())
        {
            return false;
        }
    }
    if expected.stage() != candidate.stage() && expected.advance(candidate.stage()).is_err() {
        return false;
    }
    expected == *candidate
}

#[cfg(test)]
#[path = "journal_replay_tests.rs"]
mod tests;
