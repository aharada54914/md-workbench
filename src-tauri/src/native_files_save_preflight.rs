//! Inactive existing-Document preflight. No IPC, grant creation or target writes.
use super::*;
use crate::file_access::{GrantId, SavePreflightObservation};

impl NativeState {
    /// `label` and `generation` must come from the actual native document window.
    /// `alias` is only an exact key into current non-Save metadata, never authority.
    pub(super) fn preflight_document_save(
        &self,
        label: &str,
        generation: Uuid,
        alias: &str,
        expected_grant_id: GrantId,
        expected_disk_hash: [u8; 32],
        candidate: &[u8],
    ) -> Result<SavePreflightObservation, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        // Preserve native selection's exact requested/canonical aliases. Do not
        // fall back to an older ID, normalized spelling, Export or Workspace.
        let binding = self
            .owned
            .get(&(label.to_owned(), alias.to_owned()))
            .ok_or("permission_required")?;
        if binding.id != expected_grant_id
            || binding.kind != GrantKind::Document
            || !binding.rights.can_read()
            || !binding.rights.can_write()
        {
            return Err("permission_required".into());
        }
        self.access
            .preflight_document_save(label, binding.id, expected_disk_hash, candidate)
    }
}

#[cfg(test)]
#[path = "native_files_save_preflight_tests.rs"]
mod tests;
