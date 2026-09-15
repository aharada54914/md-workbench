use super::*;
use crate::resources::transaction::tests::{digest, record};

fn present(ch: char) -> ObservedState {
    ObservedState::Present {
        hash: digest(ch),
        byte_len: 5,
    }
}

#[test]
fn early_stages_with_original_document_preserve_partial_assets_as_evidence() {
    let journal = record(2);
    let before = journal.to_json().unwrap();
    let assessment = classify(
        &journal,
        &present('a'),
        &[present('b'), ObservedState::Missing],
    )
    .unwrap();
    assert_eq!(assessment.outcome, RecoveryOutcome::OriginalRetained);
    assert_eq!(
        assessment.assets,
        [TargetStatus::ExpectedNew, TargetStatus::ExpectedPrior]
    );
    assert_eq!(journal.to_json().unwrap(), before);
    assert_eq!(
        classify(
            &journal,
            &present('a'),
            &[present('b'), ObservedState::Missing]
        )
        .unwrap(),
        assessment
    );
}

#[test]
fn new_content_is_recognized_despite_each_lagging_stage() {
    let mut journal = record(1);
    for stage in [
        Stage::Prepared,
        Stage::AssetDurable,
        Stage::DocumentDurable,
        Stage::Completed,
    ] {
        if stage == Stage::AssetDurable {
            journal.mark_asset_durable(0).unwrap();
        }
        if stage != Stage::Prepared {
            journal.advance(stage).unwrap();
        }
        let result = classify(&journal, &present('b'), &[present('b')]).unwrap();
        assert_eq!(result.outcome, RecoveryOutcome::CommittedContentObserved);
    }
}

#[test]
fn observed_conflict_missing_unavailable_or_wrong_length_never_authorizes_recovery_write() {
    let journal = record(1);
    for document in [
        present('c'),
        ObservedState::Missing,
        ObservedState::Unavailable,
        ObservedState::Present {
            hash: digest('b'),
            byte_len: 6,
        },
    ] {
        assert_eq!(
            classify(&journal, &document, &[present('b')])
                .unwrap()
                .outcome,
            RecoveryOutcome::RecoveryRequired
        );
    }
    for asset in [
        present('c'),
        ObservedState::Unavailable,
        ObservedState::Missing,
    ] {
        assert_eq!(
            classify(&journal, &present('b'), &[asset]).unwrap().outcome,
            RecoveryOutcome::RecoveryRequired
        );
    }
}

#[test]
fn durable_claims_cannot_move_back_to_prior_contents_or_missing() {
    let mut journal = record(1);
    journal.mark_asset_durable(0).unwrap();
    assert_eq!(
        classify(&journal, &present('a'), &[ObservedState::Missing])
            .unwrap()
            .outcome,
        RecoveryOutcome::RecoveryRequired
    );
    journal.advance(Stage::AssetDurable).unwrap();
    assert_eq!(
        classify(&journal, &present('a'), &[present('b')])
            .unwrap()
            .outcome,
        RecoveryOutcome::OriginalRetained
    );
    journal.advance(Stage::DocumentDurable).unwrap();
    assert_eq!(
        classify(&journal, &present('a'), &[present('b')])
            .unwrap()
            .outcome,
        RecoveryOutcome::RecoveryRequired
    );
}

#[test]
fn missing_baseline_and_identical_old_new_hashes_are_unambiguous_for_contents() {
    use crate::resources::transaction::{JournalRecord, PriorState, TargetRecord};
    let missing = TargetRecord::new("display".into(), PriorState::Missing, digest('b'), 5).unwrap();
    let journal = JournalRecord::new(record(0).id().clone(), missing, vec![]).unwrap();
    assert_eq!(
        classify(&journal, &ObservedState::Missing, &[])
            .unwrap()
            .outcome,
        RecoveryOutcome::OriginalRetained
    );
    assert_eq!(
        classify(&journal, &present('b'), &[]).unwrap().outcome,
        RecoveryOutcome::CommittedContentObserved
    );
    let same = TargetRecord::new(
        "display".into(),
        PriorState::Hash { hash: digest('b') },
        digest('b'),
        5,
    )
    .unwrap();
    let journal = JournalRecord::new(record(0).id().clone(), same, vec![]).unwrap();
    assert_eq!(
        classify(&journal, &present('b'), &[]).unwrap().outcome,
        RecoveryOutcome::CommittedContentObserved
    );
}

#[test]
fn observations_require_exact_asset_count_and_expected_new_length() {
    let journal = record(1);
    assert!(classify(&journal, &present('a'), &[]).is_err());
    assert!(classify(&journal, &present('a'), &[present('b'), present('b')]).is_err());
    let asset = ObservedState::Present {
        hash: digest('b'),
        byte_len: 6,
    };
    assert_eq!(
        classify(&journal, &present('b'), &[asset]).unwrap().outcome,
        RecoveryOutcome::RecoveryRequired
    );
}

#[test]
fn existing_asset_old_hash_and_unexpected_missing_are_separate_from_new_assets() {
    use crate::resources::transaction::tests::target;
    use crate::resources::transaction::{AssetRecord, JournalRecord, PriorState};
    let asset = AssetRecord::new(target(PriorState::Hash { hash: digest('a') }));
    let mut journal = JournalRecord::new(
        record(0).id().clone(),
        record(0).document().clone(),
        vec![asset],
    )
    .unwrap();
    let result = classify(&journal, &present('a'), &[present('a')]).unwrap();
    assert_eq!(result.outcome, RecoveryOutcome::OriginalRetained);
    assert_eq!(result.assets, [TargetStatus::ExpectedPrior]);
    let result = classify(&journal, &present('a'), &[ObservedState::Missing]).unwrap();
    assert_eq!(result.outcome, RecoveryOutcome::RecoveryRequired);
    assert_eq!(result.assets, [TargetStatus::UnexpectedMissing]);
    journal.mark_asset_durable(0).unwrap();
    journal.advance(Stage::AssetDurable).unwrap();
    assert_eq!(
        classify(&journal, &present('a'), &[present('a')])
            .unwrap()
            .outcome,
        RecoveryOutcome::RecoveryRequired
    );
}
