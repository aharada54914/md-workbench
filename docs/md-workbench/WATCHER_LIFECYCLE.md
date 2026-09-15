# Watcher lifecycle and save completion

Each watched path has a session identity, created before the asynchronous watch
installation starts. Closing a watch invalidates both pending reads and pending
installation. If an obsolete installation later succeeds, its cleanup function
runs immediately; it cannot replace a newer watch for the same path.

Within a session, only the latest requested read can update known disk content or
notify the editor. Save start, successful save, save abort, and explicit acceptance
of disk content invalidate older reads. A rejected obsolete read produces no
delete notification. Errors thrown by editor/conflict callbacks are reported as
watch errors rather than being treated as a failed disk read.

Successful save completion records the bytes actually committed to disk. Failed
write, verification, or rename calls save abort, which releases suppression without
changing known disk content. There is no post-save time grace period: an external
edit immediately after a save must still be detected. Events arriving while the
save itself is in progress retain the existing suppression behavior.

## Remaining migration work

The watcher and manual reload still use the existing documentText reader. Native
read migration is coupled to Save/Save As READ authority and typed missing-file
errors. Generic legacy read failures still follow the existing deletion path;
this change only separates callback exceptions from read failures. Save As cleanup
of the old path's watch is also deferred. Browser/unit event simulations validate
application lifecycle handling, not OS-specific notification delivery after a
file is atomically replaced or recreated.
