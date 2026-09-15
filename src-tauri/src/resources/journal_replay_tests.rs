use super::*;
use crate::resources::{journal_frame::encode_frame, transaction::tests::record};
use serde_json::json;

fn stream(records: &[JournalRecord]) -> Vec<u8> {
    records
        .iter()
        .enumerate()
        .flat_map(|(i, record)| encode_frame(i as u64 + 1, record).unwrap())
        .collect()
}
fn stages(mut value: JournalRecord) -> Vec<JournalRecord> {
    let mut records = vec![value.clone()];
    for i in 0..value.assets().len() {
        value.mark_asset_durable(i).unwrap();
    }
    for stage in [
        Stage::AssetDurable,
        Stage::DocumentDurable,
        Stage::Completed,
    ] {
        value.advance(stage).unwrap();
        records.push(value.clone());
    }
    records
}
fn reidentify(value: &JournalRecord, id: usize) -> JournalRecord {
    let mut wire: serde_json::Value = serde_json::from_slice(&value.to_json().unwrap()).unwrap();
    wire["transaction_id"] = json!(uuid::Uuid::from_u128(id as u128 + 1).to_string());
    JournalRecord::parse_json(&serde_json::to_vec(&wire).unwrap()).unwrap()
}
fn transition_failure(records: &[JournalRecord], accepted: usize) {
    let report = replay_metadata(&stream(records));
    assert_eq!(
        report.status(),
        ReplayStatus::InvalidHistory(HistoryError::Transition)
    );
    assert_eq!(report.last_sequence(), accepted as u64);
    assert_eq!(report.validated_bytes(), stream(&records[..accepted]).len());
}

#[test]
fn completed_history_is_still_only_unverified_metadata() {
    for assets in [0, 3] {
        let records = stages(record(assets));
        let bytes = stream(&records);
        let report = replay_metadata(&bytes);
        assert_eq!(report.status(), ReplayStatus::CompletePrefix);
        assert_eq!(report.snapshots(), SnapshotVerification::Unverified);
        assert_eq!(report.records().next(), records.last());
        assert_eq!(report.validated_bytes(), bytes.len());
        assert_eq!(report.last_sequence(), 4);
    }
}

#[test]
fn per_asset_progress_and_interleaving_are_supported() {
    let initial = record(2);
    let mut first_asset = initial.clone();
    first_asset.mark_asset_durable(0).unwrap();
    let second = reidentify(&record(0), 2);
    let mut records = vec![initial, second.clone(), first_asset.clone()];
    records.extend(stages(first_asset).into_iter().skip(1));
    records.extend(stages(second).into_iter().skip(1));
    let report = replay_metadata(&stream(&records));
    assert_eq!(report.status(), ReplayStatus::CompletePrefix);
    assert_eq!(report.records().count(), 2);
    assert!(report.records().all(|r| r.stage() == Stage::Completed));
}

#[test]
fn partial_final_frame_never_adopts_a_new_stage() {
    let records = stages(record(0));
    let prefix = stream(&records[..3]);
    let last = encode_frame(4, &records[3]).unwrap();
    for cut in 1..last.len() {
        let bytes = [prefix.as_slice(), &last[..cut]].concat();
        let report = replay_metadata(&bytes);
        assert_eq!(report.status(), ReplayStatus::IncompleteTail, "cut {cut}");
        assert_eq!(report.validated_bytes(), prefix.len());
        assert_eq!(report.last_sequence(), 3);
        assert_eq!(report.records().next(), Some(&records[2]));
    }
    // Losing a complete final frame is observationally only a shorter prefix.
    assert_eq!(
        replay_metadata(&prefix).status(),
        ReplayStatus::CompletePrefix
    );
    assert_eq!(replay_metadata(&[]).status(), ReplayStatus::CompletePrefix);
}

#[test]
fn corrupt_middle_or_complete_final_frame_stops_without_resynchronization() {
    let records = stages(record(0));
    for damaged in [1, 3] {
        let mut bytes = stream(&records);
        let offset = stream(&records[..damaged]).len();
        bytes[offset + 40] ^= 1;
        let report = replay_metadata(&bytes);
        assert_eq!(
            report.status(),
            ReplayStatus::InvalidHistory(HistoryError::Frame(FrameError::HashMismatch))
        );
        assert_eq!(report.validated_bytes(), offset);
        assert_eq!(report.last_sequence(), damaged as u64);
    }
}

#[test]
fn sequence_gaps_duplicates_reorder_and_bad_start_fail() {
    for sequence in [1, 3, u64::MAX] {
        let records = stages(record(0));
        let mut bytes = encode_frame(1, &records[0]).unwrap();
        bytes.extend(encode_frame(sequence, &records[1]).unwrap());
        assert_eq!(
            replay_metadata(&bytes).status(),
            ReplayStatus::InvalidHistory(HistoryError::Sequence)
        );
    }
    assert_eq!(
        replay_metadata(&encode_frame(2, &record(0)).unwrap()).status(),
        ReplayStatus::InvalidHistory(HistoryError::Sequence)
    );
}

#[test]
fn initial_and_terminal_records_cannot_bypass_history() {
    let all = stages(record(1));
    for record in &all[1..] {
        transition_failure(std::slice::from_ref(record), 0);
    }
    let mut already_durable = all[0].clone();
    already_durable.mark_asset_durable(0).unwrap();
    transition_failure(&[already_durable], 0);
    transition_failure(&[all[0].clone(), all[0].clone()], 1);
    transition_failure(&[all[0].clone(), all[2].clone()], 1);
    transition_failure(&[all[0].clone(), all[1].clone(), all[0].clone()], 2);
    let mut duplicate_end = all.clone();
    duplicate_end.push(all[3].clone());
    transition_failure(&duplicate_end, 4);
    duplicate_end[4] = all[0].clone();
    transition_failure(&duplicate_end, 4);
}

#[test]
fn asset_regressions_and_every_immutable_target_field_fail() {
    let initial = record(2);
    let mut durable = initial.clone();
    durable.mark_asset_durable(0).unwrap();
    transition_failure(&[initial.clone(), durable.clone(), initial.clone()], 2);
    for field in ["display_path", "prior", "new_hash", "byte_len"] {
        for target in ["document", "asset"] {
            let mut wire: serde_json::Value =
                serde_json::from_slice(&durable.to_json().unwrap()).unwrap();
            let slot = if target == "document" {
                &mut wire["document"]
            } else {
                &mut wire["assets"][0]["target"]
            };
            slot[field] = match field {
                "display_path" => json!("/different.md"),
                "prior" => {
                    if slot[field]["kind"] == "missing" {
                        json!({"kind":"hash","hash":"c".repeat(64)})
                    } else {
                        json!({"kind":"missing"})
                    }
                }
                "new_hash" => json!("c".repeat(64)),
                _ => json!(6),
            };
            let changed = JournalRecord::parse_json(&serde_json::to_vec(&wire).unwrap()).unwrap();
            transition_failure(&[initial.clone(), changed], 1);
        }
    }
    let mut wire: serde_json::Value = serde_json::from_slice(&durable.to_json().unwrap()).unwrap();
    wire["assets"].as_array_mut().unwrap().pop();
    transition_failure(
        &[
            initial,
            JournalRecord::parse_json(&serde_json::to_vec(&wire).unwrap()).unwrap(),
        ],
        1,
    );
}

#[test]
fn reordered_distinct_assets_cannot_change_the_recorded_slots() {
    let mut wire: serde_json::Value =
        serde_json::from_slice(&record(2).to_json().unwrap()).unwrap();
    wire["assets"][1]["target"]["display_path"] = json!("/second.svg");
    let initial = JournalRecord::parse_json(&serde_json::to_vec(&wire).unwrap()).unwrap();
    wire["assets"].as_array_mut().unwrap().swap(0, 1);
    wire["assets"][0]["state"] = json!("DURABLE");
    let reordered = JournalRecord::parse_json(&serde_json::to_vec(&wire).unwrap()).unwrap();
    transition_failure(&[initial, reordered], 1);
}

#[test]
fn limits_reject_without_evicting_or_adopting_failed_records() {
    let report = replay_metadata(&vec![0; MAX_HISTORY_BYTES + 1]);
    assert_eq!(report.status(), ReplayStatus::LimitExceeded);
    assert_eq!(report.records().count(), 0);
    let initial = record(0);
    let records: Vec<_> = (0..MAX_HISTORY_TRANSACTIONS + 1)
        .map(|i| reidentify(&initial, i))
        .collect();
    let report = replay_metadata(&stream(&records));
    assert_eq!(report.status(), ReplayStatus::LimitExceeded);
    assert_eq!(report.records().count(), MAX_HISTORY_TRANSACTIONS);
    assert_eq!(report.last_sequence(), MAX_HISTORY_TRANSACTIONS as u64);
    let mut full = Vec::new();
    for value in &records[..MAX_HISTORY_TRANSACTIONS] {
        full.extend(stages(value.clone()));
    }
    assert_eq!(full.len(), MAX_HISTORY_FRAMES);
    assert_eq!(
        replay_metadata(&stream(&full)).status(),
        ReplayStatus::CompletePrefix
    );
    full.push(records.last().unwrap().clone());
    let report = replay_metadata(&stream(&full));
    assert_eq!(report.status(), ReplayStatus::LimitExceeded);
    assert_eq!(report.last_sequence(), MAX_HISTORY_FRAMES as u64);
}

#[test]
fn unknown_versions_and_bad_tail_headers_are_explicit() {
    let mut bytes = encode_frame(1, &record(0)).unwrap();
    bytes[8..12].copy_from_slice(&2u32.to_le_bytes());
    assert_eq!(
        replay_metadata(&bytes).status(),
        ReplayStatus::UnsupportedVersion
    );
    let mut bytes = encode_frame(1, &record(0)).unwrap();
    bytes.extend_from_slice(b"wrong");
    assert_eq!(
        replay_metadata(&bytes).status(),
        ReplayStatus::InvalidHistory(HistoryError::Frame(FrameError::InvalidHeader))
    );
}

#[test]
fn unknown_payload_version_has_a_distinct_replay_outcome() {
    use sha2::{Digest, Sha256};
    let initial = record(0);
    let mut wire: serde_json::Value = serde_json::from_slice(&initial.to_json().unwrap()).unwrap();
    wire["version"] = json!(2);
    let payload = serde_json::to_vec(&wire).unwrap();
    let mut frame = encode_frame(1, &initial).unwrap();
    frame.truncate(40);
    frame[36..40].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(&payload);
    frame.extend_from_slice(&Sha256::digest(&frame));
    frame.extend_from_slice(b"MDWJEND\0");
    let result = replay_metadata(&frame);
    assert_eq!(result.status(), ReplayStatus::UnsupportedVersion);
    assert_eq!(result.validated_bytes(), 0);
    assert_eq!(result.records().count(), 0);
}
