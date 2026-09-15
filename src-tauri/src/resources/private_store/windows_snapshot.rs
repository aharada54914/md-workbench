use super::*;
use crate::resources::transaction::TransactionId;
pub(super) struct OwnedSnapshot {
    transaction: TransactionId,
    identity: (u32, u32, u32),
}
fn leaf(tx: &TransactionId) -> String {
    format!("{}.document-snapshot.v1", tx.as_str())
}
impl Root {
    pub(in super::super) fn create_snapshot(
        &mut self,
        tx: &TransactionId,
    ) -> Result<File, StoreError> {
        if !self.created || self.snapshot_identity.is_some() {
            return Err(StoreError::AlreadyExists);
        }
        let sd = acl::descriptor(&acl::private_sddl(&self.user, false))
            .map_err(|e| err(Op::CreateFile, e))?;
        let file = open(
            &self.path()?.join(leaf(tx)),
            GENERIC_READ | GENERIC_WRITE | DELETE,
            0,
            Some(&sd),
        )
        .map_err(|e| err(Op::CreateFile, e))?;
        let id = identity(&file, false).map_err(|e| err(Op::InspectFile, e))?;
        self.snapshot_identity = Some(OwnedSnapshot {
            transaction: tx.clone(),
            identity: id,
        });
        self.check_snapshot(&file, tx)?;
        Ok(file)
    }
    fn check_snapshot(&self, file: &File, tx: &TransactionId) -> Result<(), StoreError> {
        check_file(file).map_err(|e| err(Op::InspectFile, e))?;
        let id = identity(file, false).map_err(|e| err(Op::InspectFile, e))?;
        if id.0
            != identity(&self.dir, true)
                .map_err(|e| err(Op::InspectRoot, e))?
                .0
            || self
                .snapshot_identity
                .as_ref()
                .is_some_and(|owned| &owned.transaction != tx || owned.identity != id)
        {
            return Err(StoreError::Unsafe {
                reason: Policy::Changed,
            });
        }
        Ok(())
    }
    fn snapshot_file(&self, tx: &TransactionId, delete: bool) -> Result<File, StoreError> {
        let file = open(
            &self.path()?.join(leaf(tx)),
            GENERIC_READ | if delete { DELETE } else { 0 },
            0,
            None,
        )
        .map_err(|e| err(Op::Read, e))?;
        self.check_snapshot(&file, tx)?;
        Ok(file)
    }
    pub(in super::super) fn open_snapshot(&self, tx: &TransactionId) -> Result<File, StoreError> {
        self.snapshot_file(tx, false)
    }
    pub(in super::super) fn flush_snapshot_root(&self) -> Result<(), StoreError> {
        flush_file(&self.dir).map_err(|e| err(Op::FlushRoot, e))
    }
    pub(super) fn cleanup_snapshot(&self) -> Result<(), StoreError> {
        if let Some(owned) = &self.snapshot_identity {
            let file = self.snapshot_file(&owned.transaction, true)?;
            delete_handle(&file)?;
        }
        Ok(())
    }
}
