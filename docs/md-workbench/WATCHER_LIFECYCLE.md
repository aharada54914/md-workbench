# Watcher lifecycle and save completion

Each watched path has a session identity, created before the asynchronous watch
installation starts. Closing a watch invalidates both pending reads and pending
installation. If an obsolete installation later succeeds, its native subscription
is released immediately; it cannot replace a newer watch for the same path.

Within a session, only the current read revision can update known disk content or
notify the editor. Save start, successful save, save abort, and explicit acceptance
of disk content invalidate older reads. A rejected obsolete read produces no
delete notification. Errors thrown by editor/conflict callbacks are reported as
watch errors rather than being treated as a failed disk read.

Successful save completion records the bytes actually committed to disk. Failed
write, verification, or rename calls save abort, which releases suppression without
changing known disk content. There is no post-save time grace period: an external
edit immediately after a save must still be detected. Polling pauses while the save itself is in progress, and both End and Abort
request a catch-up through the shared limiter.

## Native polling and visible permission loss

Watcher reads use current native subscription identities; manual reload resolves
Document/Workspace READ and binds `native_read_path` to that grant ID. Both use a
pure UTF-8 decoder preserving BOM and newline bytes. No plugin watcher or read
fallback is used. Only native `file_not_found` is deletion evidence. Other failures
show a persistent per-path warning; permission failures pause until explicit
native same-path selection rebinds the subscription without replacing dirty text.
Rebinding also invalidates old manual reads and conflicts. Cancel leaves state
unchanged, and choosing another path retains the original tab's warning.

One renderer-wide scheduler retains the in-flight slot even after close/rebind,
starts watch reads at least 250 ms apart, and normally polls again 1 second after
settlement. These provisional engineering values are not measured latency or
performance acceptance. Installation immediately requests a first read through
that limiter to catch edits between open and subscribe. Manual reads are explicit
user operations outside the polling scheduler.

Save As releases the old path only after its last tab owner leaves. Native Save
READ adoption remains unimplemented: a newly saved ungranted destination shows a
saved-but-monitoring-paused warning until Open File explicitly reselects it.
See [native subscription contract](NATIVE_DOCUMENT_WATCH.md) for authority and
quota details. Browser/unit simulations validate application lifecycle handling,
not packaged OS behavior or detection of every intermediate disk version.

## Duplicate tabs and external conflict queue

A watcher observation captures every current tab object with the affected path across
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
watcher observation, direct/manual reload, or successful save in any same-path tab
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
and filesystem observations; actual packaged OS behavior is not established
by these unit tests.

Chromium integration in `watcher-conflict-queue.test.ts` passed three scenarios:
FIFO dialogs for dirty documents, reset merge selections between candidates,
and stale Load/Merge answers advancing without changing the local buffer.
These tests use the actual App and modal with mocked native polling reads;
they also verify saved source and dirty state. They do not exercise OS delivery.

### Save and watcher dialog ordering

A save conflict and a watcher conflict can become pending for the same document
at the same time. App keeps the first displayed dialog mounted until it closes;
the other request retains its existing candidate or Promise and mounts afterward.
Only the displayed dialog receives clicks or Escape. Its in-progress merge
selection is retained. The existing source/identity guards still validate each
answer, so a queued Save answer cannot overwrite a buffer whose earlier watcher
answer adopted a different baseline. This display ordering does not add a disk
transaction or change conflict decisions.

`save-watch-conflict-order.test.ts` covers both arrival orders, selection
preservation, Escape affecting only the first dialog, and an obsolete queued
Save answer. `shared-watch-owner.test.ts` gates mock polling completion explicitly
for its three manual-target cases: a disk write without an event is still visible
to real polling and therefore cannot isolate manual reload by itself. The
separate watcher owner/fanout tests retain the real frontend polling scheduler.
