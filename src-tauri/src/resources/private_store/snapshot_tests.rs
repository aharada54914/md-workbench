use super::*;
use crate::resources::transaction::{AssetRecord, TargetRecord};
const SESSION: &str = "177540e6-11e9-4572-bbfe-a8216bc7c7fa";
pub(crate) fn record(before: Option<&[u8]>, after: &[u8]) -> JournalRecord {
    JournalRecord::new(
        TransactionId::parse("d6d3a9cb-94d9-4c5d-8337-87c274807c61").unwrap(),
        TargetRecord::new(
            "synthetic.md".into(),
            before.map_or(PriorState::Missing, |v| PriorState::Hash { hash: hash(v) }),
            hash(after),
            after.len() as u64,
        )
        .unwrap(),
        vec![],
    )
    .unwrap()
}
fn bundle(before: Option<&[u8]>, after: &[u8]) -> (JournalRecord, Vec<u8>) {
    let r = record(before, after);
    let mut bytes = encode_header(SESSION, &r, before, after).unwrap();
    bytes.extend_from_slice(before.unwrap_or_default());
    bytes.extend_from_slice(after);
    (r, bytes)
}
#[test]
fn exact_opaque_bytes_and_missing_are_distinct_from_present_empty() {
    for before in [None, Some(&b""[..]), Some(&b"\xef\xbb\xbfA\r\n \t\xff"[..])] {
        let after = b"\xff\0\r\n";
        let (r, bytes) = bundle(before, after);
        let v = verify(&mut &bytes[..], bytes.len() as u64, SESSION, &r).unwrap();
        assert_eq!(v.before(), before);
        assert_eq!(v.after(), after);
        assert_eq!(v.namespace(), NamespaceDurability::Unestablished);
    }
}
#[test]
fn every_truncation_and_extra_byte_is_rejected() {
    let (r, bytes) = bundle(Some(b"before"), b"after");
    for end in 0..bytes.len() {
        assert!(verify(&mut &bytes[..end], end as u64, SESSION, &r).is_err());
    }
    let mut extra = bytes.clone();
    extra.push(0);
    assert!(verify(&mut &extra[..], extra.len() as u64, SESSION, &r).is_err());
    // A dishonest extent cannot hide actual trailing bytes.
    assert!(verify(&mut &extra[..], bytes.len() as u64, SESSION, &r).is_err());
}
#[test]
fn payload_corruption_session_and_transaction_binding_are_rejected() {
    let (r, mut bytes) = bundle(Some(b"before"), b"after");
    *bytes.last_mut().unwrap() ^= 1;
    assert_eq!(
        verify(&mut &bytes[..], bytes.len() as u64, SESSION, &r).unwrap_err(),
        SnapshotError::HashMismatch
    );
    let (r, bytes) = bundle(None, b"after");
    assert_eq!(
        verify(
            &mut &bytes[..],
            bytes.len() as u64,
            "1cce3b91-7e53-4428-acf2-40eecfd73c77",
            &r
        )
        .unwrap_err(),
        SnapshotError::BindingMismatch
    );
    let mut h: serde_json::Value = serde_json::from_slice(&bytes[PREFIX..bytes.len() - 5]).unwrap();
    for (key, value, expected) in [
        (
            "version",
            serde_json::json!(2),
            SnapshotError::UnsupportedVersion,
        ),
        (
            "session",
            serde_json::json!("forged"),
            SnapshotError::BindingMismatch,
        ),
        (
            "unknown",
            serde_json::json!(1),
            SnapshotError::InvalidEnvelope,
        ),
    ] {
        let saved = h.clone();
        h[key] = value;
        let json = serde_json::to_vec(&h).unwrap();
        let mut bad = MAGIC.to_vec();
        bad.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bad.extend(json);
        bad.extend(b"after");
        assert_eq!(
            verify(&mut &bad[..], bad.len() as u64, SESSION, &r).unwrap_err(),
            expected
        );
        h = saved;
    }
}
#[test]
fn preflight_rejects_wrong_bytes_stage_assets_and_presence() {
    let r = record(None, b"after");
    assert!(validate_input(&r, Some(b""), b"after").is_err());
    assert!(validate_input(&r, None, b"other").is_err());
    let mut late = r.clone();
    late.advance(Stage::AssetDurable).unwrap();
    assert!(validate_input(&late, None, b"after").is_err());
    let assets = JournalRecord::new(
        r.id().clone(),
        r.document().clone(),
        vec![AssetRecord::new(r.document().clone())],
    )
    .unwrap();
    assert!(validate_input(&assets, None, b"after").is_err());
    assert_eq!(
        verify(&mut &b""[..], MAX_BUNDLE + 1, SESSION, &r).unwrap_err(),
        SnapshotError::LimitExceeded
    );
}

#[test]
fn header_duplicate_keys_wrong_roles_and_oversized_lengths_reject_before_payload_allocation() {
    let (r, bytes) = bundle(None, b"after");
    let n = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let original = std::str::from_utf8(&bytes[PREFIX..PREFIX + n]).unwrap();
    for json in [
        original.replacen("\"version\":1", "\"version\":1,\"version\":1", 1),
        original.replacen(
            "\"state\":\"missing\"",
            "\"state\":\"missing\",\"unexpected\":true",
            1,
        ),
        original.replacen("\"role\":\"before\"", "\"role\":\"after\"", 1),
        original.replace("\"byte_len\":5", "\"byte_len\":18446744073709551615"),
    ] {
        let mut bad = MAGIC.to_vec();
        bad.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bad.extend(json.as_bytes());
        bad.extend(b"after");
        assert!(verify(&mut &bad[..], bad.len() as u64, SESSION, &r).is_err());
    }
    let mut bad = MAGIC.to_vec();
    bad.extend_from_slice(&((MAX_HEADER + 1) as u32).to_le_bytes());
    assert_eq!(
        verify(&mut &bad[..], bad.len() as u64, SESSION, &r).unwrap_err(),
        SnapshotError::LimitExceeded
    );
}
