//! Exclusive directory creation beneath a retained workspace handle.
use super::*;

impl FileAccess {
    pub(crate) fn create_directory(
        &self,
        window: &str,
        id: GrantId,
        relative: &Path,
    ) -> Result<(), AccessError> {
        let grant = self.get(window, id, Rights::WRITE)?;
        if grant.info.kind != GrantKind::Workspace || grant.anchor.file_name.is_some() {
            return Err(AccessError::InvalidKind);
        }
        let (parent, name) = resolve_parent(&grant.anchor, relative)?;
        // A single validated leaf: cap-std performs exclusive directory creation.
        // Windows reconstructs a path from the retained directory handle and
        // protects directory lookups by denying delete sharing.
        // Existing files, directories and links are errors, never followed.
        parent.create_dir(name)?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "file_access_create_tests.rs"]
mod tests;
