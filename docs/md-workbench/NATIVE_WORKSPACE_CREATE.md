# Native workspace creation

## Scope and API

`create_md_file({ parent, name })` and `create_folder({ parent, name })` keep their
command names, arguments and successful path-string result. Both commands now
receive the actual Tauri caller window and run blocking I/O outside the main
thread. Errors use the existing `{ code, message }` native command DTO;
permission failures are `permission_required`, invalid portable paths are
`invalid_path`, and collisions/OS failures are `filesystem_error`.

Only current, caller-owned **Workspace WRITE** metadata supplies authority.
The existing native path resolver selects the longest workspace prefix, with
precise native aliases preferred on ties. It chooses before checking WRITE:
a narrower read-only workspace cannot fall back to a broader writable workspace.
It does not merge rights, search historical grant IDs, or use resource/document/
Save export permissions. WRITE-only Workspace grants are sufficient. The window
generation is captured before scheduling and checked while holding the same
registry lock through selection and I/O; destruction/recreation cannot reuse it.
Path strings never create grants or trigger ambient canonicalization.

## Creation behavior

Names retain the previous outer-whitespace trimming and Markdown extension rule:
`.md`, `.markdown` and `.mdx` are preserved case-insensitively; other file names
receive `.md`. The trimmed name must be one portable child component **before**
extension addition. Dot segments, separators, ADS/device spellings, control
characters, trailing dots and Windows reserved names are rejected on all systems.
The parent-relative path also passes the existing core validation.

Files use `FileAccess::create_new` with empty bytes and exclusive nofollow open.
Folders use `FileAccess::create_directory`, which requires Workspace WRITE,
walks parent directories through retained nofollow handles, and invokes cap-std
4.0.3 single-leaf exclusive directory creation. On Unix this uses directory-relative
creation. On Windows cap-primitives reconstructs the parent path from its retained
handle and uses `std::fs::create_dir`; its directory handles deny `FILE_SHARE_DELETE`
to protect these lookups from directory rename/deletion. This is the pinned
dependency's sandboxed operation, not a Windows handle-relative mkdir syscall.
Existing files, folders and
symlinks are errors; no overwrite, recursive parent creation or cleanup occurs.
The returned absolute path is a display/reference only, never an I/O authority.

On Unix an already retained parent continues referring to that directory if its
original filesystem path is renamed/replaced. Windows directory handles instead
deny delete sharing as described above. A symlink/junction encountered during the
parent walk is rejected. This is handle-bound operation semantics, not a promise
that another process cannot rename that directory. File sync failure can leave
the newly created empty file; callers receive an error and no pre-existing item
is removed. Folder creation is not a crash-durable save transaction.

## Verification and remaining scope

Native tests cover missing/foreign/read-only/revoked grants and stale generations,
WRITE-only grants, current metadata precedence, unrelated grant purposes,
portable name/parent rejection, extension compatibility, exclusive collisions,
Unix root/intermediate-parent substitution, and symlink leaves/parents. A Windows
native test covers separator aliases and junction denial. Windows/Linux CI and
packaged GUI creation remain separate from local macOS unit verification.

Rename, deletion, save, restore/journal and broad plugin FS permissions are outside
this slice. Their presence means this change alone does not complete T04/T05.
