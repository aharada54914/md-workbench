# Windows storage API probe

This independent diagnostic measures API return values. It does not activate the
editor's journal or Save code, and does not establish power-loss durability,
namespace persistence, ACL privacy, process isolation, or recovery guarantees.

## Run

From the repository root, with Rust installed:

```text
cargo test --locked --manifest-path scripts/native-storage-probe/Cargo.toml
cargo run --quiet --locked --manifest-path scripts/native-storage-probe/Cargo.toml
```

No arguments are accepted. On Windows the probe exclusively creates one UUID
directory under the OS temporary directory, then creates a fixed child directory
and a bounded synthetic BOM/CRLF file. It queries the filesystem through the open
directory handle. Only NTFS proceeds to the API matrix. The temp location is a
diagnostic location, not a model for private journal provisioning or authority.

The matrix records:

- `cap-std 4.0.3` read-only directory open and `FlushFileBuffers` baseline.
- Explicit directory opens requesting `GENERIC_READ | GENERIC_WRITE`,
  `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT`, and only
  `FILE_SHARE_READ | FILE_SHARE_WRITE` (no delete sharing).
- Exclusive synthetic file creation, `write_all`, and native `FlushFileBuffers`.
- Native flushes on the empty child directory and its parent, which contains
  both the new child and the synthetic file.

File creation/flush is an independent control and still runs when a read/write
directory open fails. A failed operation is never retried with weaker access or
sharing flags. Directory metadata rejects reparse points. There is no privileged
volume flush, elevation, write-through substitution, or product fallback.

Cleanup occurs after test handles close and removes only entries this run created,
using retained parents and nonrecursive removals. A cleanup failure is reported
and may leave a disposable `mdw-storage-probe-<UUID>` directory in the OS temp
directory. A killed process may also leave its fixture. The probe writes no user
document contents and does not enumerate or recursively delete temp directories.

## Output and exit codes

Standard output is one JSON object plus LF, together at most 16 KiB. It includes
`schema_version: 1`, `scope: "api_support_only"`, platform, filesystem type/flags,
requested directory access/share/flags, and 13 ordered operation results. No user
path, UUID, volume label/serial, error message, or file content is emitted.

Each `outcome.status` is one of:

- `success`: that specific operation returned success.
- `win32_error`: numeric `code` captured from the failing call.
- `probe_error`: fixed reason enum; inspection or I/O could not produce the
  required observation. This is not evidence of unsupported directory flush.
- `skipped`: `prerequisite_failed`, `non_ntfs`, or `unsupported_platform`.

Exit 0 means a valid measurement report was emitted, including reports with API
errors or skipped operations. **It does not mean directory flush is supported.**
Exit 1 means report validation/output failed; exit 2 means invalid arguments.
Non-Windows runs emit only `unsupported_platform` skips and touch no fixtures.
CI should retain the JSON even when an API is unsupported, inspect each outcome,
and attach runner OS/build/architecture separately for interpretation.

## Validation and evidence limits

Pure tests check the bounded schema, error/success/skip distinction, fixed
operation order, and rejection of path-like/unbounded filesystem metadata.
Windows-specific tests check Win32 code preservation and the requested flags.
Cross-compilation checks types and ABI declarations; it does not execute Win32.
Run the executable on real Windows to obtain measurements. Successful API returns
still need separate namespace-durability research and crash/power-loss evidence
before a journal durability claim. ACL/token/hostile-substitution tests are also
outside this first probe.

Microsoft documents the write-access requirement and the zero/nonzero result
contract for [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).
Filesystem metadata is queried with [GetVolumeInformationByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew).
