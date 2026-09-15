use super::*;
use crate::resources::transaction::TransactionId;
pub(super) struct OwnedSnapshot {
    transaction: TransactionId,
    identity: (dev_t, ino_t),
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
        let file = open_at(
            &self.dir,
            leaf(tx).as_bytes(),
            O_RDWR | O_CREAT | O_EXCL,
            0o600,
        )
        .map_err(|e| StoreError::io(Op::CreateFile, e))?;
        let s = stat(&file).map_err(|e| StoreError::io(Op::InspectFile, e))?;
        // Remember only our exclusive-created object, including partial-write failures.
        self.snapshot_identity = Some(OwnedSnapshot {
            transaction: tx.clone(),
            identity: (s.st_dev, s.st_ino),
        });
        self.check_snapshot(&file, tx)?;
        cv(unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) })
            .map_err(|e| StoreError::io(Op::Lock, e))?;
        Ok(file)
    }
    fn check_snapshot(&self, file: &File, tx: &TransactionId) -> Result<(), StoreError> {
        check_file(file).map_err(|_| StoreError::Unsafe {
            reason: Policy::Permissions,
        })?;
        let s = stat(file).map_err(|e| StoreError::io(Op::InspectFile, e))?;
        if s.st_dev
            != stat(&self.dir)
                .map_err(|e| StoreError::io(Op::InspectRoot, e))?
                .st_dev
            || self.snapshot_identity.as_ref().is_some_and(|owned| {
                &owned.transaction != tx || owned.identity != (s.st_dev, s.st_ino)
            })
        {
            return Err(StoreError::Unsafe {
                reason: Policy::Changed,
            });
        }
        Ok(())
    }
    pub(in super::super) fn open_snapshot(&self, tx: &TransactionId) -> Result<File, StoreError> {
        let file = open_at(&self.dir, leaf(tx).as_bytes(), O_RDONLY | O_NONBLOCK, 0)
            .map_err(|e| StoreError::io(Op::Read, e))?;
        self.check_snapshot(&file, tx)?;
        cv(unsafe { flock(file.as_raw_fd(), LOCK_SH | LOCK_NB) })
            .map_err(|e| StoreError::io(Op::Lock, e))?;
        Ok(file)
    }
    pub(in super::super) fn flush_snapshot_root(&self) -> Result<(), StoreError> {
        barrier(&self.dir, Op::FlushRoot)
    }
    pub(super) fn cleanup_snapshot(&self) -> Result<(), StoreError> {
        if let Some(owned) = &self.snapshot_identity {
            let file = self.open_snapshot(&owned.transaction)?;
            // Same-user hostile namespace mutation remains outside the macOS contract.
            cv(unsafe {
                unlinkat(
                    self.dir.as_raw_fd(),
                    c(leaf(&owned.transaction).as_bytes()).unwrap().as_ptr(),
                    0,
                )
            })
            .map_err(|e| StoreError::io(Op::Cleanup, e))?;
            drop(file);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tx() -> TransactionId {
        TransactionId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap()
    }
    #[test]
    fn snapshot_fixed_leaf_type_permissions_and_retained_identity() {
        let (mut root, journal) = Root::create().unwrap();
        let tx = tx();
        let file = root.create_snapshot(&tx).unwrap();
        assert!(matches!(
            root.create_snapshot(&tx),
            Err(StoreError::AlreadyExists)
        ));
        cv(unsafe { fchmod(file.as_raw_fd(), 0o644) }).unwrap();
        assert!(root.check_snapshot(&file, &tx).is_err());
        cv(unsafe { fchmod(file.as_raw_fd(), 0o600) }).unwrap();
        let name = c(leaf(&tx).as_bytes()).unwrap();
        cv(unsafe {
            linkat(
                root.dir.as_raw_fd(),
                name.as_ptr(),
                root.dir.as_raw_fd(),
                c"extra-link".as_ptr(),
                0,
            )
        })
        .unwrap();
        assert!(root.check_snapshot(&file, &tx).is_err());
        cv(unsafe { unlinkat(root.dir.as_raw_fd(), c"extra-link".as_ptr(), 0) }).unwrap();
        drop(file);
        cv(unsafe {
            renameat(
                root.dir.as_raw_fd(),
                name.as_ptr(),
                root.dir.as_raw_fd(),
                c"original-snapshot".as_ptr(),
            )
        })
        .unwrap();
        cv(unsafe { mkfifoat(root.dir.as_raw_fd(), name.as_ptr(), 0o600) }).unwrap();
        assert!(root.open_snapshot(&tx).is_err());
        cv(unsafe { unlinkat(root.dir.as_raw_fd(), name.as_ptr(), 0) }).unwrap();
        cv(unsafe { symlinkat(c"journal.v1".as_ptr(), root.dir.as_raw_fd(), name.as_ptr()) })
            .unwrap();
        assert!(root.open_snapshot(&tx).is_err());
        cv(unsafe { unlinkat(root.dir.as_raw_fd(), name.as_ptr(), 0) }).unwrap();
        let replacement = open_at(
            &root.dir,
            leaf(&tx).as_bytes(),
            O_RDWR | O_CREAT | O_EXCL,
            0o600,
        )
        .unwrap();
        assert!(matches!(
            root.open_snapshot(&tx),
            Err(StoreError::Unsafe {
                reason: Policy::Changed
            })
        ));
        drop(replacement);
        cv(unsafe { unlinkat(root.dir.as_raw_fd(), name.as_ptr(), 0) }).unwrap();
        cv(unsafe {
            renameat(
                root.dir.as_raw_fd(),
                c"original-snapshot".as_ptr(),
                root.dir.as_raw_fd(),
                name.as_ptr(),
            )
        })
        .unwrap();
        drop(journal);
        root.cleanup().unwrap();
    }
}
