//! Pure framing of metadata bytes. A trailing marker is not a flush acknowledgement.
use super::transaction::{JournalError, JournalRecord, MAX_JOURNAL_BYTES};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAGIC: &[u8; 8] = b"MDWJFRM\0";
const MARKER: &[u8; 8] = b"MDWJEND\0";
const VERSION: u32 = 1;
const HEADER_BYTES: usize = 40;
const DIGEST_BYTES: usize = 32;
pub const FRAME_OVERHEAD: usize = HEADER_BYTES + DIGEST_BYTES + MARKER.len();
pub const MAX_FRAME_BYTES: usize = MAX_JOURNAL_BYTES + FRAME_OVERHEAD;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    Incomplete,
    InvalidHeader,
    UnsupportedVersion,
    LimitExceeded,
    InvalidMarker,
    HashMismatch,
    InvalidPayload(JournalError),
    TransactionMismatch,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DecodedFrame {
    pub sequence: u64,
    pub record: JournalRecord,
    pub consumed: usize,
}

pub fn encode_frame(sequence: u64, record: &JournalRecord) -> Result<Vec<u8>, FrameError> {
    if sequence == 0 {
        return Err(FrameError::InvalidHeader);
    }
    let payload = record.to_json().map_err(FrameError::InvalidPayload)?;
    let length = u32::try_from(payload.len()).map_err(|_| FrameError::LimitExceeded)?;
    let total = payload
        .len()
        .checked_add(FRAME_OVERHEAD)
        .ok_or(FrameError::LimitExceeded)?;
    let id = Uuid::parse_str(record.id().as_str()).map_err(|_| FrameError::InvalidHeader)?;
    let mut bytes = Vec::with_capacity(total);
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&VERSION.to_le_bytes());
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(id.as_bytes());
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.extend_from_slice(&payload);
    let hash = Sha256::digest(&bytes);
    bytes.extend_from_slice(&hash);
    bytes.extend_from_slice(MARKER);
    Ok(bytes)
}

pub fn decode_frame(input: &[u8]) -> Result<DecodedFrame, FrameError> {
    // Check every complete header field before calling a short suffix incomplete.
    let prefix = input.len().min(MAGIC.len());
    if input[..prefix] != MAGIC[..prefix] {
        return Err(FrameError::InvalidHeader);
    }
    let version = u32::from_le_bytes(field(input, 8)?);
    if version != VERSION {
        return Err(FrameError::UnsupportedVersion);
    }
    let sequence = u64::from_le_bytes(field(input, 12)?);
    if sequence == 0 {
        return Err(FrameError::InvalidHeader);
    }
    let id = Uuid::from_bytes(field(input, 20)?);
    if id.is_nil() {
        return Err(FrameError::InvalidHeader);
    }
    let length = usize::try_from(u32::from_le_bytes(field(input, 36)?))
        .map_err(|_| FrameError::LimitExceeded)?;
    if length == 0 || length > MAX_JOURNAL_BYTES {
        return Err(FrameError::LimitExceeded);
    }
    let payload_end = HEADER_BYTES
        .checked_add(length)
        .ok_or(FrameError::LimitExceeded)?;
    let digest_end = payload_end
        .checked_add(DIGEST_BYTES)
        .ok_or(FrameError::LimitExceeded)?;
    let consumed = digest_end
        .checked_add(MARKER.len())
        .ok_or(FrameError::LimitExceeded)?;
    if input.len() < consumed {
        return Err(FrameError::Incomplete);
    }
    if &input[digest_end..consumed] != MARKER {
        return Err(FrameError::InvalidMarker);
    }
    let hash = Sha256::digest(&input[..payload_end]);
    if hash[..] != input[payload_end..digest_end] {
        return Err(FrameError::HashMismatch);
    }
    let record = JournalRecord::parse_json(&input[HEADER_BYTES..payload_end])
        .map_err(FrameError::InvalidPayload)?;
    if record.id().as_str() != id.hyphenated().to_string() {
        return Err(FrameError::TransactionMismatch);
    }
    Ok(DecodedFrame {
        sequence,
        record,
        consumed,
    })
}

fn field<const N: usize>(input: &[u8], offset: usize) -> Result<[u8; N], FrameError> {
    let end = offset.checked_add(N).ok_or(FrameError::LimitExceeded)?;
    input
        .get(offset..end)
        .ok_or(FrameError::Incomplete)?
        .try_into()
        .map_err(|_| FrameError::Incomplete)
}

#[cfg(test)]
#[path = "journal_frame_tests.rs"]
mod tests;
