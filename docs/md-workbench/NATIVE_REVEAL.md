# Native file manager reveal — T04 / T05

`reveal_in_os` uses the invoking editor window and its current native READ grant.
A path, recent entry, renderer event or claimed window label cannot grant access.
An optional expected grant ID rejects stale selections. Save/export WRITE-only
selections do not authorize reveal, and there is no historical-grant fallback.

The broker opens the target through retained directory authority without following
symlinks or Windows reparse points. Only regular files and directories are
accepted. Before dispatch, it opens the native-selected display location and
compares the retained anchor, every traversed directory and the final file by
filesystem identity. A moved root replaced at its old name is rejected, including
when the replacement contains a hard link to the same leaf. Verified handles
remain live through dispatch; the registry lock prevents revocation or window
label reuse from racing with the queued command.

Windows receives a validated Explorer selection argument; macOS uses `open -R`.
Linux opens the containing directory with `xdg-open`, avoiding arbitrary file
associations. Filesystem roots always have a nonempty absolute output location.
The OS file manager resolves that location again after dispatch. An external
writer can still change it afterward: this is an OS handoff, **not** a primitive
for document reads, writes or atomic identity guarantees.

The tab menu, tree menu and workspace header show translated failures. Permission
errors explain native reselection, unsupported operations are explicit, and other
failures use a readable message without raw host details. Failed reveal does not
retry, open a picker automatically, refresh the workspace or change the document.

## Verification scope

Native tests cover owned and foreign grants, revocation/window reuse, stale IDs,
write-only export denial, roots, empty files, invalid paths, launcher failure,
symlinks/reparse points and parent/leaf substitution. Browser tests exercise the
three error-display entry points and preserve document/workspace state. They do
not establish real OS file-manager behavior or full T04 acceptance.
