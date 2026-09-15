# Filesystem broker: host API contract

Implemented stage 1, 2026-09-15. This module is not yet connected to application
commands. Existing filesystem permissions and commands remain unchanged; T04 is
not complete until the migration in [the plan](FILESYSTEM_BROKER_PLAN.md) is done.

## Authority and lifecycle

`src-tauri/src/file_access.rs` exports crate-private Rust APIs only. None is a
Tauri command. Manage one `Mutex<FileAccess>` in the native host and hold its lock
through each operation: revocation then waits for in-flight I/O and no open file
handle escapes the registry. Derive caller labels from Tauri's injected window
or native events; never accept the caller label from renderer arguments.

| API | Contract |
| --- | --- |
| `register_window(window)` | Host calls after creating `main` or a `window-N` editor. Unknown and print/preview labels are rejected. |
| `grant_file_from_native_selection(window, path, kind, rights)` | Native picker/OS-open path only. Grants exactly one Document, Resource or Export file. Only Export may initially be missing. |
| `grant_directory_from_native_selection(window, path, kind, rights)` | Native picker/drop only; an explicitly selected Workspace or Resource directory. |
| `transfer(source, target, id, rights)` | Source must own the grant; target must be registered; rights can only decrease. Creates a new target UUID and shares the retained anchor. |
| `revoke(window, id)` / `revoke_window(window)` | Remove a grant or the window and all its grants. A reused window label does not revive previous UUIDs. |
| `describe(window, id)` | Returns owned grant metadata. `selected_path` is for display/routing only; never reopen it with ambient filesystem APIs. |
| `read(window, id, relative, limit)` | Requires READ. Returns regular-file bytes unchanged, including BOM/CRLF. Caller limit cannot exceed 64 MiB and growth while reading is bounded. |
| `create_new(window, id, relative, bytes)` | Requires WRITE. Exclusive new-file creation, at most 64 MiB, then sync. Existing entries cannot be overwritten. |

`GrantId` is an opaque UUID with parse/display support. Knowing its string does
not authorize another window. `Rights` has READ, WRITE and READ_WRITE constants.
Grant kind and rights remain separate: a resource may be read-only; an export
may be write-only. `AccessError` distinguishes permission, invalid path/kind,
unsupported platform, oversized I/O and OS failures. Integration should map these
to structured frontend errors rather than interpreting an OS error string.

Exact-file operations use an empty relative path. Directory operations use clean
UTF-8 slash-separated paths such as `images/chart.png`. A relative path cannot
contain `.`/`..`, empty segments, backslashes, absolute/UNC/device prefixes, ADS
colons, control characters, Windows reserved basenames or trailing dots/spaces.
The portable naming policy deliberately rejects names that are unsafe on another
supported platform. Native selections must be absolute. A canonical UNC selection
is permitted only from the native authority source; operation input cannot choose
a new share. Non-UTF-8 selections require a future explicit frontend contract.

## How authorization reaches real I/O

Native selection canonicalization chooses the anchor. The host then opens the
native root and walks each directory component with `open_dir_nofollow`, retaining
a `cap_std::fs::Dir`. Exact-file grants retain a parent handle plus one basename;
directory grants retain the selected directory handle. Each operation walks
intermediate names relative to those handles without following symlinks. The final
read uses `FollowSymlinks::No` and checks metadata on the opened handle. Exclusive
creation uses `create_new` with the same nofollow policy. No operation performs
`canonicalize` followed by an ambient path open.

The implementation uses pinned cap-std/cap-fs-ext 4.0.3. Their documented
[Dir API](https://docs.rs/cap-std/4.0.3/cap_std/fs/struct.Dir.html) and
[nofollow extension](https://docs.rs/cap-fs-ext/4.0.3/cap_fs_ext/trait.DirExt.html)
provide the handle operations. Do not substitute `Dir::from_std_file`: Windows
requires directory handles without delete sharing. The dependency implementation
also opens Windows reparse points before checking nofollow and prevents pinned
directory renames. Keep the native junction test in Windows CI.

Authority follows the retained directory object if it is renamed on Unix; it does
not follow a replacement symlink at the old path. On Windows an open capability
directory may prevent that rename. An explicitly selected symlink resolves at
grant creation, but later symlink aliases are rejected even when they point inside
the same grant. Native selection authority begins when the host obtains the
anchor; path-only dialogs do not provide an earlier immutable file identity.
Ordinary hard links and mount points are filesystem entries, not symlink escapes;
this contract does not isolate against an actor able to alter filesystem mounts.

Windows, macOS and Linux are supported. Grant creation and I/O fail closed on
other targets. The existing AI path checker (`ai/process/file_tools.rs`) was not
reused because its canonicalized `PathBuf` is later reopened by ambient APIs.

## Remaining integration and operations

- Connect trusted native open/save/workspace/resource pickers, CLI, OS-open and
  drag/drop events before granting. A recent/localStorage path, Markdown reference,
  tab URL or renderer-supplied access map must never call a native-selection API.
- Restore authority only from a validated native private record or ask for a new
  selection. Transfer rights before target frontend reads and revoke the source
  after a successful close acknowledgement.
- Implement overwrite/CAS, journal/recovery, rename/delete, directory enumeration,
  directory creation and watch using retained handles. These APIs are deliberately
  absent; a caller must not emulate them with `GrantInfo.selected_path`.
- `create_new` can leave its newly created partial file after an I/O failure. It
  does not attempt unsafe path-based cleanup. Save and export completion semantics
  need a host transaction/recovery implementation before using it for those flows.
- Derive resource destinations from authorized documents without exposing a generic
  parent-directory write grant. Add bounds appropriate to each operation.
- Migrate all frontend/custom command I/O and AI tool authorization, then remove
  wildcard permissions and verify print/preview denial through actual IPC.

## Verification

`cargo test --manifest-path src-tauri/Cargo.toml file_access::tests` exercises actual
filesystem I/O, not mocks: raw bytes, exact-file bounds, ownership, transfer,
revocation, rights, exclusive export, path aliases, symlink leaf/parent replacement,
bounded reads and a concurrent Unix parent/symlink swap with outside-file checks.
Windows adds a real junction test; its symlink tests require an elevated runner or
Developer Mode and intentionally fail if fixtures cannot be created.

The 11 applicable tests passed locally on macOS; the full native suite passed
212 tests with zero failures. Windows and Linux execution and
packaged native IPC/UX acceptance remain required; their results are not inferred
from the macOS run. No coverage percentage was measured.
