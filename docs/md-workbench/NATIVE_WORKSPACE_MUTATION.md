# Native workspace rename and deletion

## Caller and authority

`rename_path({ from, to })` and `delete_path({ path })` preserve the existing IPC
argument names and successful void result. Both now receive Tauri's actual
caller Window and run blocking filesystem work on a worker. The window
generation is captured before scheduling and checked under the native registry
lock, which stays held through resolution and mutation.

Both rename endpoints independently require a current caller-owned Workspace
WRITE grant. Delete requires one such grant. The existing longest-prefix/native
alias path resolver selects current metadata before checking WRITE, so a narrower
read-only selection cannot fall back to broader rights. Document, Resource,
Export/Save, other-window and historical grants do not supply workspace mutation
authority. Renderer strings never create grants or trigger ambient
canonicalization. Each core operation rechecks grant ownership, kind and rights.

Empty relative paths (selected workspace roots) are prohibited. Intermediate
parents and final names pass the existing portable path validation; parent
walking uses retained `open_dir_nofollow` handles. A rename of the same grant and
relative path is a no-op only after both authorizations and path validations.
Operations address the current selected workspace, not an earlier rendered row's
inode or grant UUID. This slice adds no expected-row identity contract.

## No-overwrite rename

Linux/macOS use rustix 1.1.4 `renameat_with(..., NOREPLACE)` on both retained
parents and single basenames. Unsupported kernel/filesystem behavior fails;
there is no ordinary rename, copy/delete or existence-check fallback.

Windows uses the separate `file_access_rename_windows.rs` adapter: a nofollow
source handle with DELETE access, retained destination directory handle and
`NtSetInformationFile(FileRenameInformation)` with ReplaceIfExists false. The
adapter rejects source reparse objects. Pinned cap-std opens this source with
`SYNCHRONIZE` and `FILE_SYNCHRONOUS_IO_NONALERT`; all I/O through that handle
completes synchronously before the aligned buffer and IO status block are
released. Only `STATUS_SUCCESS` is accepted; native errors are translated with
`RtlNtStatusToDosError`, including destination collisions. Windows tests inspect
the actual source handle's synchronous mode as well as collision behavior. See
[the native rename contract](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)
and [synchronous handle semantics](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwcreatefile).

Unix may rename a final symlink itself;
intermediate links are rejected everywhere. Case-only moves on a case-insensitive
filesystem may conservatively fail. Cross-filesystem moves return an OS error
without a copy/unlink fallback. Existing destinations, including links and
folders, remain untouched by the no-replace operation.

## Bounded permanent deletion

The explicit walker visits at most **10,000 entries including the requested
entry**, and at most **50 descendant levels** below it. Exact limits succeed;
observing the next entry/depth fails the operation. Every entry counts, including
unsupported names/types. It consumes unfiltered directory entries and retains
each parent throughout traversal. It does not use recursive bulk deletion.

Files are unlinked by basename. Final symlinks are removed as links; Windows
directory symlinks/junctions use nonrecursive directory removal. Unknown reparse
objects, special files and unsupported portable names fail instead of being
silently skipped. Descendant directories are opened nofollow. After emptying a
directory, only that child's handle is released before one nonrecursive removal
through its retained parent (needed for Windows delete-sharing rules).

The walker does not retry against concurrent tree growth. A failure can leave
prior removals applied. Delete errors add `partial` and `removed` to the existing
native `{ code, message }` error shape:

- `partial: false`: no destructive syscall has been attempted.
- `partial: true`: at least one deletion syscall was attempted, or the worker
  terminated unexpectedly; deletion may have partially applied.
- `removed`: number of successful leaf/directory removals confirmed by this
  worker. It is not an inventory or proof that an errored syscall had no effect.

Both operations use existing typed permission/path/not-found errors. OS
AlreadyExists becomes `already_exists`, unsupported operations/types become
`unsupported_operation`, and walker limits become `file_too_large`. Other OS
failures remain `filesystem_error`. Callers must refresh after a failed delete
and show partial failure rather than reporting completion.

## Guarantee boundaries and verification

This is name-based mutation under retained directory authority. On Unix an
externally renamed open directory remains the same retained object; paths may no
longer describe its current location. A concurrently replaced basename can be
renamed/unlinked, and final rmdir may remove a replacement empty directory.
Nofollow prevents descent through a substituted link; it is not atomic inode CAS.
On Windows cap-std directory operations may reconstruct paths from retained
handles protected by denial of FILE_SHARE_DELETE. The Windows rename adapter
requires real Windows validation in addition to cross-compilation.

Tests cover caller/grant/generation isolation, rights on both endpoints, root
and portable-name rejection, no-op authorization, exclusive destination races,
byte-preserving moves, delete bounds and injected partial failures. Unix race
seams replace parents/children before inspection, after open and before final
removal; outside sentinels must survive. Windows tests cover links/junctions,
directory pinning and the no-replace adapter.

No trash, Undo, rollback, save journal, fsync durability, dirty-tab/path migration
or resource-link rewriting is added. Legacy broad plugin permissions and other
remaining broker migrations are separate; this slice does not complete T04/T05.
