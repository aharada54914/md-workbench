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


## Duplicate tabs and external conflict queue

A watcher event captures every current tab object with the affected path across
all panes. Each clean object is reloaded independently; each dirty object retains
its local buffer and gets its own conflict. The active editor alone is reseeded.
Manual reload still selects only the captured active object, even when another
tab has the same path.

Conflicts wait in FIFO order. The displayed diff remains unchanged while other
events arrive. Each queued object retains only its latest pending disk version;
repeated observations do not accumulate a history of dialogs. A new observation
for the displayed object invalidates the old answer and queues its latest
version. Resolving that obsolete dialog advances to the current candidates
without changing the buffer. Each displayed candidate has a new Vue component
key, so merge selections from the previous dialog cannot carry over.

Before showing or applying a candidate, the editor checks the same live tab
object, its path, source/visual buffer, original baseline, dirty state, and disk
observation identity. Closed, replaced, rebound, or subsequently edited objects
are skipped. Moving the same object between panes remains valid. Queue pruning
runs on observations and consumption; pending entries are bounded by current
eligible tab objects, plus at most one displayed stale object. Unwatching a path
removes its pending/displayed conflicts; stopping all watches clears the queue.
Each pending manual read also captures a path-wide observation token. A newer
watcher event, direct/manual reload, or successful save in any same-path tab
invalidates both its delayed success and failure. Unwatching invalidates pending
reads even when that path had no earlier observation.

Delayed conflict answers also require the candidate to equal the most recently
observed/accepted same-path disk content before applying buffer changes or
updating the shared watcher baseline. This prevents a dialog for one duplicate
from rewinding a newer manual reload, direct reload, or successful save associated
with another duplicate. If disk content changes away and back to the identical
candidate, that candidate is usable only while its individual tab identity and
snapshot checks still hold; this is byte equality, not filesystem revision
identity. The path-wide token still invalidates a pending manual read in that case.

Validation: `useFileReload-fanout.test.ts` reproduces the former first-match
reload and modal-overwrite failures and covers mixed clean/dirty duplicates,
multiple paths, repeated newer disk versions, all conflict actions, stale queued
objects, pane moves, watch cleanup, and pending manual reads. Existing manual
identity and watcher lifecycle tests remain required. These are simulated editor
and filesystem notifications; actual OS notification delivery is not established
by these unit tests.

Chromium integration in `watcher-conflict-queue.test.ts` passed three scenarios:
FIFO dialogs for dirty documents, reset merge selections between candidates,
and stale Load/Merge answers advancing without changing the local buffer.
These tests use the actual App and modal with mocked native watch callbacks;
they also verify saved source and dirty state. They do not exercise OS delivery.
