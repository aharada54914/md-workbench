//! Read-only interpretation of externally supplied observations. No observation
//! is acquired by path here. The host must authorize and hash each retained target
//! independently; journal metadata cannot reconstitute expired permissions.
use super::transaction::{
    AssetState, JournalError, JournalRecord, PriorState, Sha256Digest, Stage, TargetRecord,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservedState {
    Missing,
    Present {
        hash: Sha256Digest,
        byte_len: u64,
    },
    /// Includes permission denial/read failure; never interpreted as Missing.
    Unavailable,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetStatus {
    ExpectedPrior,
    ExpectedNew,
    UnexpectedMissing,
    Conflict,
    Unavailable,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryOutcome {
    OriginalRetained,
    /// All new contents were observed, including when journal stages lag. This
    /// is not proof of directory sync, actual publication, or crash durability.
    CommittedContentObserved,
    RecoveryRequired,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryAssessment {
    pub outcome: RecoveryOutcome,
    pub document: TargetStatus,
    pub assets: Vec<TargetStatus>,
}
fn target_status(target: &TargetRecord, observed: &ObservedState) -> TargetStatus {
    match observed {
        ObservedState::Unavailable => TargetStatus::Unavailable,
        ObservedState::Missing => {
            if *target.prior() == PriorState::Missing {
                TargetStatus::ExpectedPrior
            } else {
                TargetStatus::UnexpectedMissing
            }
        }
        ObservedState::Present { hash, byte_len } => {
            // Prefer new when old==new: bytes match, but this says nothing about
            // whether a rename occurred. Inconsistent length is always conflict.
            if hash == target.new_hash() {
                return if *byte_len == target.byte_len() {
                    TargetStatus::ExpectedNew
                } else {
                    TargetStatus::Conflict
                };
            }
            if matches!(target.prior(), PriorState::Hash {hash: prior} if prior == hash) {
                TargetStatus::ExpectedPrior
            } else {
                TargetStatus::Conflict
            }
        }
    }
}

/// The asset observations use the exact journal order. Repeat inspection is
/// idempotent; no record updates, retry, rollback, or orphan deletion follows.
pub fn classify(
    journal: &JournalRecord,
    document: &ObservedState,
    assets: &[ObservedState],
) -> Result<RecoveryAssessment, JournalError> {
    if assets.len() != journal.assets().len() {
        return Err(JournalError::InvalidSchema);
    }
    let document = target_status(journal.document(), document);
    let assets: Vec<_> = journal
        .assets()
        .iter()
        .zip(assets)
        .map(|(record, observed)| target_status(record.target(), observed))
        .collect();
    let all_new = assets
        .iter()
        .all(|status| *status == TargetStatus::ExpectedNew);
    let assets_consistent =
        journal
            .assets()
            .iter()
            .zip(&assets)
            .all(|(record, status)| match status {
                TargetStatus::ExpectedNew => true,
                TargetStatus::ExpectedPrior => record.state() == AssetState::Planned,
                _ => false,
            });
    let outcome = if document == TargetStatus::ExpectedNew && all_new {
        RecoveryOutcome::CommittedContentObserved
    } else if document == TargetStatus::ExpectedPrior
        && assets_consistent
        && matches!(journal.stage(), Stage::Prepared | Stage::AssetDurable)
    {
        RecoveryOutcome::OriginalRetained
    } else {
        RecoveryOutcome::RecoveryRequired
    };
    Ok(RecoveryAssessment {
        outcome,
        document,
        assets,
    })
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;
