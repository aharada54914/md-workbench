//! Bounded document-only snapshot envelope. Bytes inspected here prove no disk authority.
use super::super::transaction::{
    JournalRecord, PriorState, Sha256Digest, Stage, TransactionId, MAX_TARGET_BYTES,
};
use super::NamespaceDurability;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{self, Read};
const MAGIC: &[u8; 8] = b"MDWSNP01";
const PREFIX: usize = 12;
pub(super) const MAX_HEADER: usize = 4096;
pub(super) const MAX_BUNDLE: u64 = MAX_TARGET_BYTES * 2 + MAX_HEADER as u64 + PREFIX as u64;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotError {
    InvalidInput,
    InvalidEnvelope,
    UnsupportedVersion,
    LimitExceeded,
    BindingMismatch,
    HashMismatch,
    Truncated,
    ReadFailed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Role {
    Before,
    After,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum Payload {
    Missing {},
    Present { byte_len: u64, hash: Sha256Digest },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Part {
    role: Role,
    payload: Payload,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Slot {
    Document,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    version: u32,
    session: String,
    transaction: TransactionId,
    slot: Slot,
    before: Part,
    after: Part,
}
#[derive(Debug)]
pub struct VerifiedDocumentSnapshotBytes {
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}
impl VerifiedDocumentSnapshotBytes {
    pub fn before(&self) -> Option<&[u8]> {
        self.before.as_deref()
    }
    pub fn after(&self) -> &[u8] {
        &self.after
    }
    pub fn namespace(&self) -> NamespaceDurability {
        NamespaceDurability::Unestablished
    }
}
fn hash(bytes: &[u8]) -> Sha256Digest {
    Sha256Digest::parse(&format!("{:x}", Sha256::digest(bytes))).expect("SHA256 hex")
}
fn valid_session(session: &str) -> bool {
    uuid::Uuid::parse_str(session)
        .ok()
        .is_some_and(|id| !id.is_nil() && id.to_string() == session)
}
pub(super) fn validate_input(
    record: &JournalRecord,
    before: Option<&[u8]>,
    after: &[u8],
) -> Result<(), SnapshotError> {
    if record.stage() != Stage::Prepared || !record.assets().is_empty() {
        return Err(SnapshotError::InvalidInput);
    }
    if after.len() as u64 > MAX_TARGET_BYTES
        || before.is_some_and(|v| v.len() as u64 > MAX_TARGET_BYTES)
    {
        return Err(SnapshotError::LimitExceeded);
    }
    before
        .unwrap_or_default()
        .len()
        .checked_add(after.len())
        .filter(|n| *n as u64 <= MAX_TARGET_BYTES * 2)
        .ok_or(SnapshotError::LimitExceeded)?;
    if record.document().byte_len() != after.len() as u64
        || record.document().new_hash() != &hash(after)
    {
        return Err(SnapshotError::BindingMismatch);
    }
    match (record.document().prior(), before) {
        (PriorState::Missing, None) => {}
        (PriorState::Hash { hash: expected }, Some(bytes)) if expected == &hash(bytes) => {}
        _ => return Err(SnapshotError::BindingMismatch),
    }
    Ok(())
}
pub(super) fn encode_header(
    session: &str,
    record: &JournalRecord,
    before: Option<&[u8]>,
    after: &[u8],
) -> Result<Vec<u8>, SnapshotError> {
    validate_input(record, before, after)?;
    if !valid_session(session) {
        return Err(SnapshotError::BindingMismatch);
    }
    let part = |role, bytes: Option<&[u8]>| Part {
        role,
        payload: match bytes {
            None => Payload::Missing {},
            Some(v) => Payload::Present {
                byte_len: v.len() as u64,
                hash: hash(v),
            },
        },
    };
    let h = Header {
        version: 1,
        session: session.into(),
        transaction: record.id().clone(),
        slot: Slot::Document,
        before: part(Role::Before, before),
        after: part(Role::After, Some(after)),
    };
    let json = serde_json::to_vec(&h).map_err(|_| SnapshotError::InvalidEnvelope)?;
    if json.len() > MAX_HEADER {
        return Err(SnapshotError::LimitExceeded);
    }
    let mut out = Vec::with_capacity(PREFIX + json.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend(json);
    Ok(out)
}
fn read_exact(reader: &mut impl Read, bytes: &mut [u8]) -> Result<(), SnapshotError> {
    reader.read_exact(bytes).map_err(|e| {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            SnapshotError::Truncated
        } else {
            SnapshotError::ReadFailed
        }
    })
}
pub(super) fn verify(
    reader: &mut impl Read,
    extent: u64,
    session: &str,
    record: &JournalRecord,
) -> Result<VerifiedDocumentSnapshotBytes, SnapshotError> {
    if extent > MAX_BUNDLE {
        return Err(SnapshotError::LimitExceeded);
    }
    let mut prefix = [0; PREFIX];
    read_exact(reader, &mut prefix)?;
    if &prefix[..8] != MAGIC {
        return Err(SnapshotError::InvalidEnvelope);
    }
    let n = u32::from_le_bytes(prefix[8..].try_into().unwrap()) as usize;
    if n == 0 || n > MAX_HEADER {
        return Err(SnapshotError::LimitExceeded);
    }
    let mut bytes = vec![0; n];
    read_exact(reader, &mut bytes)?;
    let h: Header = serde_json::from_slice(&bytes).map_err(|_| SnapshotError::InvalidEnvelope)?;
    if h.version != 1 {
        return Err(SnapshotError::UnsupportedVersion);
    }
    if !valid_session(session)
        || h.session != session
        || h.transaction != *record.id()
        || !record.assets().is_empty()
        || h.before.role != Role::Before
        || h.after.role != Role::After
    {
        return Err(SnapshotError::BindingMismatch);
    }
    let length = |p: &Payload| match p {
        Payload::Missing {} => 0,
        Payload::Present { byte_len, .. } => *byte_len,
    };
    let (before_len, after_len) = (length(&h.before.payload), length(&h.after.payload));
    if before_len > MAX_TARGET_BYTES || after_len > MAX_TARGET_BYTES {
        return Err(SnapshotError::LimitExceeded);
    }
    let total = (PREFIX as u64)
        .checked_add(n as u64)
        .and_then(|v| v.checked_add(before_len))
        .and_then(|v| v.checked_add(after_len))
        .ok_or(SnapshotError::LimitExceeded)?;
    if total != extent {
        return Err(SnapshotError::InvalidEnvelope);
    }
    match (&h.before.payload, record.document().prior()) {
        (Payload::Missing {}, PriorState::Missing) => {}
        (Payload::Present { hash, .. }, PriorState::Hash { hash: expected })
            if hash == expected => {}
        _ => return Err(SnapshotError::BindingMismatch),
    }
    match &h.after.payload {
        Payload::Present { hash, byte_len }
            if hash == record.document().new_hash()
                && *byte_len == record.document().byte_len() => {}
        _ => return Err(SnapshotError::BindingMismatch),
    }
    let mut payload = |part: Payload| -> Result<Option<Vec<u8>>, SnapshotError> {
        match part {
            Payload::Missing {} => Ok(None),
            Payload::Present {
                byte_len,
                hash: expected,
            } => {
                let mut bytes = vec![0; byte_len as usize];
                read_exact(reader, &mut bytes)?;
                if hash(&bytes) != expected {
                    return Err(SnapshotError::HashMismatch);
                }
                Ok(Some(bytes))
            }
        }
    };
    let before = payload(h.before.payload)?;
    let after = payload(h.after.payload)?.ok_or(SnapshotError::BindingMismatch)?;
    let mut extra = [0];
    match reader.read(&mut extra) {
        Ok(0) => {}
        Ok(_) => return Err(SnapshotError::InvalidEnvelope),
        Err(_) => return Err(SnapshotError::ReadFailed),
    }
    Ok(VerifiedDocumentSnapshotBytes { before, after })
}
#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
