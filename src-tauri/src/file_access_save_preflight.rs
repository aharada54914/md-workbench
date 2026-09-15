//! A byte observation, not a transaction, commit authority, or external-writer CAS.
use super::*;
use sha2::{Digest, Sha256};

// No Serialize, Debug (source bytes), grant, path, handle, or commit method.
// Accessors borrow immutable bytes; later disk writes do not update this value.
pub(crate) struct SavePreflightObservation {
    before: Vec<u8>,
    candidate: Vec<u8>,
    before_hash: [u8; 32],
    candidate_hash: [u8; 32],
}
impl SavePreflightObservation {
    pub(crate) fn before(&self) -> &[u8] {
        &self.before
    }
    pub(crate) fn candidate(&self) -> &[u8] {
        &self.candidate
    }
    pub(crate) fn before_hash(&self) -> &[u8; 32] {
        &self.before_hash
    }
    pub(crate) fn candidate_hash(&self) -> &[u8; 32] {
        &self.candidate_hash
    }
}

impl FileAccess {
    /// Caller holds NativeState's lock throughout binding validation and this call.
    /// Existing Document only: no Missing prior state, SaveAs or Workspace path.
    /// A read sees bytes from one opened leaf, not an atomic snapshot against
    /// another process modifying that same file during/after the read.
    pub(crate) fn preflight_document_save(
        &self,
        window: &str,
        id: GrantId,
        expected_disk_hash: [u8; 32],
        candidate: &[u8],
    ) -> Result<SavePreflightObservation, String> {
        let grant = self
            .get(window, id, Rights::READ_WRITE)
            .map_err(|e| e.to_string())?;
        if grant.info.kind != GrantKind::Document {
            return Err(AccessError::InvalidKind.to_string());
        }
        // Check before disk I/O or duplicating caller-owned candidate bytes.
        if candidate.len() > MAX_IO_BYTES {
            return Err(AccessError::TooLarge.to_string());
        }
        let before = self
            .read(window, id, Path::new(""), MAX_IO_BYTES)
            .map_err(|e| e.to_string())?;
        let before_hash: [u8; 32] = Sha256::digest(&before).into();
        if before_hash != expected_disk_hash {
            return Err("stale_disk".into());
        }
        Ok(SavePreflightObservation {
            before,
            candidate: candidate.to_vec(),
            before_hash,
            candidate_hash: Sha256::digest(candidate).into(),
        })
    }
}
