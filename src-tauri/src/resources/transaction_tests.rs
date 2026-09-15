use super::*;
use serde_json::{json, Value};

pub(crate) fn digest(ch: char) -> Sha256Digest {
    Sha256Digest::parse(&ch.to_string().repeat(64)).unwrap()
}
pub(crate) fn target(prior: PriorState) -> TargetRecord {
    TargetRecord::new("/display/文書.md".into(), prior, digest('b'), 5).unwrap()
}
pub(crate) fn record(assets: usize) -> JournalRecord {
    JournalRecord::new(
        TransactionId::parse("d6d3a9cb-94d9-4c5d-8337-87c274807c61").unwrap(),
        target(PriorState::Hash { hash: digest('a') }),
        (0..assets)
            .map(|_| AssetRecord::new(target(PriorState::Missing)))
            .collect(),
    )
    .unwrap()
}
fn raw() -> Value {
    serde_json::from_slice(&record(1).to_json().unwrap()).unwrap()
}
fn parse(value: Value) -> Result<JournalRecord, JournalError> {
    JournalRecord::parse_json(&serde_json::to_vec(&value).unwrap())
}

#[test]
fn roundtrip_preserves_metadata_and_tracks_existing_versus_new_assets() {
    let before = record(1);
    let encoded = before.to_json().unwrap();
    assert_eq!(JournalRecord::parse_json(&encoded).unwrap(), before);
    assert_eq!(before.document().display_path(), "/display/文書.md");
    assert_eq!(before.document().byte_len(), 5);
    assert_eq!(before.assets()[0].target().prior(), &PriorState::Missing);
    assert_eq!(before.assets()[0].state(), AssetState::Planned);
    let fields = raw();
    assert!(fields.get("source").is_none());
    assert_eq!(fields["stage"], "PREPARED");
    assert_eq!(fields["version"], 1);
}

#[test]
fn stages_require_assets_and_only_adjacent_forward_transitions() {
    let mut journal = record(2);
    let original = journal.clone();
    assert!(journal.advance(Stage::AssetDurable).is_err());
    assert!(journal.advance(Stage::DocumentDurable).is_err());
    assert!(journal.mark_asset_durable(2).is_err());
    assert_eq!(journal, original);
    journal.mark_asset_durable(0).unwrap();
    assert!(journal.advance(Stage::AssetDurable).is_err());
    journal.mark_asset_durable(1).unwrap();
    journal.advance(Stage::AssetDurable).unwrap();
    assert!(journal.mark_asset_durable(0).is_err());
    assert!(journal.advance(Stage::Prepared).is_err());
    journal.advance(Stage::DocumentDurable).unwrap();
    journal.advance(Stage::Completed).unwrap();
    assert!(journal.advance(Stage::Completed).is_err());
    assert_eq!(
        JournalRecord::parse_json(&journal.to_json().unwrap()).unwrap(),
        journal
    );
}

#[test]
fn empty_asset_set_still_uses_explicit_stage_boundaries() {
    let mut journal = record(0);
    assert!(journal.advance(Stage::DocumentDurable).is_err());
    for stage in [
        Stage::AssetDurable,
        Stage::DocumentDurable,
        Stage::Completed,
    ] {
        journal.advance(stage).unwrap();
    }
}

#[test]
fn rejects_unknown_version_stage_schema_and_missing_required_fields() {
    for (key, value) in [
        ("version", json!(2)),
        ("version", json!(1.0)),
        ("stage", json!("ROLLBACK")),
        ("source", json!("secret")),
    ] {
        let mut value_object = raw();
        value_object[key] = value;
        assert!(parse(value_object).is_err(), "{key}");
    }
    let mut value = raw();
    value.as_object_mut().unwrap().remove("assets");
    assert!(parse(value).is_err());
    for key in ["source", "grant_id", "authority"] {
        let mut value = raw();
        value["document"][key] = json!("forged");
        assert!(parse(value).is_err());
    }
    let mut value = raw();
    value["document"]["prior"] = json!({"kind":"missing","hash":"a".repeat(64)});
    assert!(parse(value).is_err());
    let mut value = raw();
    value["assets"][0]["state"] = json!("UNKNOWN");
    assert!(parse(value).is_err());
}

#[test]
fn duplicate_keys_and_trailing_json_are_rejected_at_every_depth() {
    let source = String::from_utf8(record(1).to_json().unwrap()).unwrap();
    for (needle, replacement) in [
        ("\"version\":1", "\"version\":1,\"version\":1"),
        ("\"byte_len\":5", "\"byte_len\":5,\"byte_len\":5"),
        ("\"kind\":\"hash\"", "\"kind\":\"hash\",\"kind\":\"hash\""),
        (
            "\"state\":\"PLANNED\"",
            "\"state\":\"PLANNED\",\"state\":\"PLANNED\"",
        ),
    ] {
        assert!(
            JournalRecord::parse_json(source.replacen(needle, replacement, 1).as_bytes()).is_err()
        );
    }
    assert!(JournalRecord::parse_json(format!("{source} {{}}").as_bytes()).is_err());
    assert!(JournalRecord::parse_json(&[0xff]).is_err());
}

#[test]
fn digest_and_transaction_id_are_exact_canonical_values() {
    for value in [
        "a".repeat(63),
        "a".repeat(65),
        "g".repeat(64),
        "A".repeat(64),
    ] {
        assert!(Sha256Digest::parse(&value).is_err());
        let mut v = raw();
        v["document"]["new_hash"] = json!(value);
        assert!(parse(v).is_err());
    }
    for id in [
        "not-a-uuid",
        "00000000-0000-0000-0000-000000000000",
        "D6D3A9CB-94D9-4C5D-8337-87C274807C61",
        "d6d3a9cb94d94c5d833787c274807c61",
    ] {
        assert!(TransactionId::parse(id).is_err());
        let mut v = raw();
        v["transaction_id"] = json!(id);
        assert!(parse(v).is_err());
    }
}

#[test]
fn bounded_metadata_payloads_and_whole_record_fail_without_truncation() {
    for path in [
        "".into(),
        "x\0y".into(),
        "line\nbreak".into(),
        "文".repeat(1400),
    ] {
        assert!(TargetRecord::new(path, PriorState::Missing, digest('b'), 1).is_err());
    }
    assert!(TargetRecord::new(
        "x".repeat(MAX_DISPLAY_PATH_BYTES),
        PriorState::Missing,
        digest('b'),
        0
    )
    .is_ok());
    assert!(TargetRecord::new(
        "x".into(),
        PriorState::Missing,
        digest('b'),
        MAX_TARGET_BYTES + 1
    )
    .is_err());
    let mut v = raw();
    v["document"]["byte_len"] = json!(-1);
    assert!(parse(v).is_err());
    let mut v = raw();
    v["document"]["byte_len"] = json!(MAX_TARGET_BYTES + 1);
    assert!(parse(v).is_err());
    assert!(JournalRecord::parse_json(&vec![b' '; MAX_JOURNAL_BYTES + 1]).is_err());
    let mut v = raw();
    v["assets"] = json!(vec![v["assets"][0].clone(); MAX_ASSETS + 1]);
    assert!(parse(v).is_err());
    let long = TargetRecord::new(
        "x".repeat(MAX_DISPLAY_PATH_BYTES),
        PriorState::Missing,
        digest('b'),
        0,
    )
    .unwrap();
    assert!(JournalRecord::new(
        record(0).id().clone(),
        target(PriorState::Missing),
        vec![AssetRecord::new(long); MAX_ASSETS]
    )
    .is_err());
}

#[test]
fn parsed_late_stage_cannot_claim_undurable_assets() {
    for stage in ["ASSET_DURABLE", "DOCUMENT_DURABLE", "COMPLETED"] {
        let mut v = raw();
        v["stage"] = json!(stage);
        assert!(parse(v).is_err());
    }
}

#[test]
fn longer_stage_name_cannot_escape_record_size_limit_or_mutate_on_error() {
    let mut value = raw();
    let mut asset = value["assets"][0].clone();
    asset["state"] = json!("DURABLE");
    asset["target"]["display_path"] = json!("x");
    value["assets"] = json!(vec![asset; 17]);
    let mut extra = MAX_JOURNAL_BYTES - serde_json::to_vec(&value).unwrap().len();
    for asset in value["assets"].as_array_mut().unwrap() {
        let added = extra.min(MAX_DISPLAY_PATH_BYTES - 1);
        asset["target"]["display_path"] = json!("x".repeat(added + 1));
        extra -= added;
    }
    assert_eq!(extra, 0);
    let bytes = serde_json::to_vec(&value).unwrap();
    assert_eq!(bytes.len(), MAX_JOURNAL_BYTES);
    let mut journal = JournalRecord::parse_json(&bytes).unwrap();
    let before = journal.clone();
    assert_eq!(
        journal.advance(Stage::AssetDurable),
        Err(JournalError::LimitExceeded)
    );
    assert_eq!(journal, before);
}

#[test]
fn missing_prior_rejects_extra_and_duplicate_metadata_too() {
    let source = String::from_utf8(record(1).to_json().unwrap()).unwrap();
    for replacement in [
        r#""kind":"missing","grant":"forged""#,
        r#""kind":"missing","kind":"missing""#,
    ] {
        let candidate = source.replacen(r#""kind":"missing""#, replacement, 1);
        assert!(JournalRecord::parse_json(candidate.as_bytes()).is_err());
    }
    assert_eq!(digest('a').as_str(), "a".repeat(64));
    assert_eq!(
        record(0).id().as_str(),
        "d6d3a9cb-94d9-4c5d-8337-87c274807c61"
    );
}
