use super::*;
use crate::resources::{
    journal_replay::SnapshotVerification,
    transaction::{PriorState, Sha256Digest, TargetRecord, TransactionId},
};
use sha2::{Digest, Sha256};
fn record(before: Option<&[u8]>, after: &[u8]) -> JournalRecord {
    let hash = |v: &[u8]| Sha256Digest::parse(&format!("{:x}", Sha256::digest(v))).unwrap();
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
#[test]
fn actual_snapshot_roundtrip_and_creator_cleanup() {
    for before in [
        None,
        Some(&b""[..]),
        Some(&b"\xef\xbb\xbfbefore\r\n \xff"[..]),
    ] {
        let after = b"after\r\n\t\xff";
        let r = record(before, after);
        let completed =
            SnapshotSession::create(&r, before, after).unwrap_or_else(|e| panic!("{:?}", e.error));
        assert_eq!(completed.observation().sequence, 1);
        assert_eq!(
            completed.observation().snapshots,
            SnapshotVerification::Unverified
        );
        let id = completed.identifier().to_owned();
        let owner = completed.close();
        let v = PrivateSession::inspect_document_snapshot(&id).unwrap();
        assert_eq!(v.before(), before);
        assert_eq!(v.after(), after);
        assert_eq!(
            owner.inspect().unwrap().snapshots(),
            SnapshotVerification::Unverified
        );
        owner.cleanup().unwrap();
        assert!(PrivateSession::inspect_document_snapshot(&id).is_err());
    }
}
#[test]
fn rejected_input_creates_no_cleanup_owner_and_empty_history_cannot_bind_snapshot() {
    let r = record(None, b"after");
    let e = SnapshotSession::create(&r, None, b"other").err().unwrap();
    assert!(e.owner.is_none());
    let owner = FreshJournalWriter::create().unwrap().close();
    assert!(matches!(
        PrivateSession::inspect_document_snapshot(owner.identifier()),
        Err(SnapshotStoreError::UnboundHistory)
    ));
    owner.cleanup().unwrap();
}
