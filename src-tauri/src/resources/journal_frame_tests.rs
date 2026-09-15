use super::*;
use crate::resources::transaction::tests::record;
use serde_json::json;

fn rehash(bytes: &mut [u8]) {
    let end = bytes.len() - DIGEST_BYTES - MARKER.len();
    let hash = Sha256::digest(&bytes[..end]);
    bytes[end..end + DIGEST_BYTES].copy_from_slice(&hash);
}
fn with_payload(payload: &[u8]) -> Vec<u8> {
    let mut bytes = encode_frame(1, &record(0)).unwrap();
    bytes.truncate(HEADER_BYTES);
    bytes[36..40].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes.extend_from_slice(&[0; DIGEST_BYTES]);
    bytes.extend_from_slice(MARKER);
    rehash(&mut bytes);
    bytes
}

#[test]
fn golden_frame_has_portable_offsets_and_exact_payload() {
    let record = record(0);
    let payload = record.to_json().unwrap();
    let bytes = encode_frame(1, &record).unwrap();
    assert_eq!(&bytes[..8], b"MDWJFRM\0");
    assert_eq!(&bytes[8..12], &1u32.to_le_bytes());
    assert_eq!(&bytes[12..20], &1u64.to_le_bytes());
    assert_eq!(
        &bytes[20..36],
        Uuid::parse_str(record.id().as_str()).unwrap().as_bytes()
    );
    assert_eq!(&bytes[36..40], &(payload.len() as u32).to_le_bytes());
    assert_eq!(&bytes[40..40 + payload.len()], payload);
    assert_eq!(bytes.len(), payload.len() + 80);
    // Independent Python hashlib/struct vector, not a second call to this encoder.
    let hex: String = bytes[40 + payload.len()..bytes.len() - 8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        hex,
        "533aac522f6b366c0bae1dda69ed0771ae56bb0d0cb1051c193d46bef7081192"
    );
    let decoded = decode_frame(&bytes).unwrap();
    assert_eq!(decoded.record, record);
    assert_eq!(decoded.sequence, 1);
    assert_eq!(decoded.consumed, bytes.len());
}

#[test]
fn every_single_byte_mutation_is_rejected() {
    let bytes = encode_frame(1, &record(1)).unwrap();
    for offset in 0..bytes.len() {
        let mut changed = bytes.clone();
        changed[offset] ^= 1;
        assert!(decode_frame(&changed).is_err(), "offset {offset}");
    }
}

#[test]
fn every_truncated_suffix_is_incomplete_and_never_a_record() {
    let bytes = encode_frame(1, &record(1)).unwrap();
    for cut in 0..bytes.len() {
        assert_eq!(
            decode_frame(&bytes[..cut]),
            Err(FrameError::Incomplete),
            "cut {cut}"
        );
    }
    let mut concatenated = bytes.clone();
    concatenated.extend_from_slice(&bytes);
    assert_eq!(decode_frame(&concatenated).unwrap().consumed, bytes.len());
}

#[test]
fn malformed_complete_header_fields_are_not_incomplete_tails() {
    let bytes = encode_frame(1, &record(0)).unwrap();
    let mut changed = bytes[..12].to_vec();
    changed[8..12].copy_from_slice(&2u32.to_le_bytes());
    assert_eq!(decode_frame(&changed), Err(FrameError::UnsupportedVersion));
    assert_eq!(decode_frame(b"BAD"), Err(FrameError::InvalidHeader));
    let mut changed = bytes[..20].to_vec();
    changed[12..20].fill(0);
    assert_eq!(decode_frame(&changed), Err(FrameError::InvalidHeader));
    let mut changed = bytes[..36].to_vec();
    changed[20..36].fill(0);
    assert_eq!(decode_frame(&changed), Err(FrameError::InvalidHeader));
    for length in [0, (MAX_JOURNAL_BYTES + 1) as u32, u32::MAX] {
        let mut changed = bytes[..40].to_vec();
        changed[36..40].copy_from_slice(&length.to_le_bytes());
        assert_eq!(decode_frame(&changed), Err(FrameError::LimitExceeded));
    }
    assert_eq!(encode_frame(0, &record(0)), Err(FrameError::InvalidHeader));
    assert_eq!(
        decode_frame(&encode_frame(u64::MAX, &record(0)).unwrap())
            .unwrap()
            .sequence,
        u64::MAX
    );
}

#[test]
fn recomputed_hash_does_not_bypass_identity_or_schema() {
    let mut changed = encode_frame(1, &record(0)).unwrap();
    changed[20] ^= 1;
    rehash(&mut changed);
    assert_eq!(decode_frame(&changed), Err(FrameError::TransactionMismatch));
    let original = record(0).to_json().unwrap();
    let mut payload: serde_json::Value = serde_json::from_slice(&original).unwrap();
    payload["unexpected"] = json!(true);
    for bytes in [
        serde_json::to_vec(&payload).unwrap(),
        vec![0xff],
        [original.clone(), b" {}".to_vec()].concat(),
    ] {
        assert!(matches!(
            decode_frame(&with_payload(&bytes)),
            Err(FrameError::InvalidPayload(_))
        ));
    }
    payload.as_object_mut().unwrap().remove("unexpected");
    payload["version"] = json!(2);
    assert_eq!(
        decode_frame(&with_payload(&serde_json::to_vec(&payload).unwrap())),
        Err(FrameError::InvalidPayload(JournalError::UnsupportedVersion))
    );
}

#[test]
fn payload_limit_and_marker_text_are_exact() {
    let mut payload: serde_json::Value =
        serde_json::from_slice(&record(0).to_json().unwrap()).unwrap();
    payload["document"]["display_path"] = json!("/MDWJFRM/MDWJEND/文書.md");
    let bytes = serde_json::to_vec(&payload).unwrap();
    let parsed = decode_frame(&with_payload(&bytes)).unwrap();
    assert_eq!(
        parsed.record.document().display_path(),
        "/MDWJFRM/MDWJEND/文書.md"
    );
    // JSON whitespace permits an exact 64 KiB payload without weakening target limits.
    let mut padded = bytes;
    padded.resize(MAX_JOURNAL_BYTES, b' ');
    let frame = with_payload(&padded);
    assert_eq!(frame.len(), MAX_FRAME_BYTES);
    assert!(decode_frame(&frame).is_ok());
    padded.push(b' ');
    assert_eq!(
        decode_frame(&with_payload(&padded)),
        Err(FrameError::LimitExceeded)
    );
}
