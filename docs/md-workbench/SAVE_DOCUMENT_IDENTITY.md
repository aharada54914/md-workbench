# Save and document identity

Save, Save As and background save capture the originating tab object, path,
original baseline and current Markdown before awaiting dialogs or filesystem I/O.
Changing the active tab cannot substitute another document's bytes. A second save
for the same tab is rejected while the first remains pending, including while a
Save As dialog is open; destination paths also have an in-flight guard.

After each pending operation, adoption requires that the captured tab still
belongs to an open pane and retains its original path and baseline. Closing a tab,
replacing it with another object having the same ID, or changing its path cannot
revive it through a delayed save result. Moving that same tab between panes is
allowed. Changes typed while a write is pending remain dirty after the captured
snapshot is saved.

Conflict choices retain their originating tab and baseline. A merge changes that
tab's pending source and remains dirty if writing fails. It does not mark the
merged text as the saved original before disk success. A concurrent conflict
cannot replace an unresolved dialog's resolver. Loading the external Save As
destination into the original buffer does not silently rename the original tab.

Successful Save As migrates metadata and starts watching the new path only after
the result has been adopted by the originating tab. The old watch is removed only
if no other open tab still uses that path. Cancellation, stale results and failed
writes do not move the watch. An already dispatched write may finish after a tab
closes; its completion cannot restore that tab or its watches.

## Manual reload and conflict confirmation

Manual reload captures the active tab object, including when another tab has the
same path. A newer reload supersedes an older read for that tab. Delayed reads
and their errors are discarded if the tab closes, is replaced, changes path or
baseline, or acquires new raw/Visual edits. Switching focus alone keeps the
original target; it does not reseed the newly active editor.

Reload conflict Keep/Load/Merge actions revalidate that same snapshot when the
user confirms. Stale confirmations dismiss the dialog without applying its old
result. The pre-save Load External action also forwards the captured tab to the
reload helper. Closing one of several same-path tabs retains the shared watcher
and routing registration until the last owner closes.

## Verification and limits

Unit regressions cover delayed dialogs, tab replacement/closure/movement, pending
edits, concurrent saves, conflicts, late reads and source grant identity. Three
Chromium UI tests exercise switching tabs during Save As, cancellation and closing
the originating tab during the dialog. Native dialogs, files and watches are
mocked in those browser tests.

Additional unit and browser regressions cover same-path duplicate tabs, pending
manual reads, stale conflict confirmations and the last shared watcher owner.
Automatic external-change notification fan-out across duplicate tabs is separate
from the manual reload targeting covered here.

The disk writer still uses the existing plugin-filesystem temporary-file protocol.
This change does not provide a native journal, crash recovery or atomic
compare-and-swap against external writers. Those remain T08 work after the broker
migration. Open-file routing registration after Save As remains separate work.
