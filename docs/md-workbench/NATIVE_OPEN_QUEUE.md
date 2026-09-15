# Native file-open queue — T05 / R01, R20

The host retains every supported OS-open request until the elected document window consumes
it. This covers initial CLI arguments, a second instance's arguments, and macOS
`RunEvent::Opened`, including requests delivered before the webview is ready.

## Frontend contract

1. Register a listener for `open-files-pending` on every document window.
2. After registration, call `get_open_file_paths` and open each returned path in
   order. Repeat on each notification. Serialize drains/opening so concurrent
   notifications cannot race tab creation or active-tab selection.
3. The notification has no file payload. The host queues before emitting; a
   missed startup notification therefore does not lose requests.

`get_open_file_paths` atomically drains an ordered `string[]` only for the
current owner. The owner comes from Tauri's live webview registry: `main` has
priority; otherwise the lowest positive numeric `window-N` label wins. Only the
exact labels created by the backend qualify. Print (`window-print`), preview,
unknown labels, and windows absent from the registry cannot consume requests.
A blank or unsaved document window remains eligible; the file-to-window registry
is not an owner requirement.

Non-owner calls and empty queues return `[]`. The legacy `get_open_file_path`
consumes one path and returns `null` for a non-owner or empty queue. Both APIs
share the queue; document frontends should use one API consistently.

On window destruction, the host excludes the closing label and notifies the new
owner if requests remain. This also handles a stale registry entry during the
close event. If no document window or consumer is ready, requests remain queued;
the new consumer's listener-before-getter startup sequence handles registration
races. Owner notifications restore and focus that window, including when `main`
has already closed.

The queue is in memory and provides delivery until the getter consumes a batch.
There is no frontend acknowledgement or persistent delivery journal: process
exit loses queued requests, and destroying a webview after it has drained a
batch but before opening every file can lose that batch's unfinished requests.
Guaranteeing replay across those failures requires an acknowledgement protocol.

Native warm-open delivery now emits `open-files-pending`, replacing the previous
`open-file` payload event. It must be integrated with the frontend in the same
release. Tab-transfer and focus-file events keep their existing contracts.

## Path treatment

- All supported `.md` / `.markdown` CLI arguments are considered in input order;
  extension matching ignores case. The executable argument is skipped.
- Relative arguments resolve against the launching process's working directory,
  including the directory supplied by the single-instance plugin. An unavailable
  or relative working directory cannot authorize guessing another directory.
- Arguments starting with `-` are ignored until `--`. URI arguments containing
  `://` are ignored; URI decoding belongs to native URL/deep-link ingress.
- Native macOS file URLs use `to_file_path` exactly once. Native path arguments
  preserve literal percent signs, Unicode, spaces, and separators. Non-UTF-8
  paths are skipped instead of substituting replacement characters.
- There is no existence check or canonicalization here. Missing/read-only files
  still reach the existing file-open error handling. This queue does not grant
  filesystem permissions or claim to solve path authorization.
- Duplicate paths already pending are coalesced, preserving their first position.
  Opening the same path again after a drain is a fresh request.

## Verification and remaining acceptance

`src-tauri/src/open_files.rs` contains twelve native unit tests for ordered cold
and warm delivery, legacy drain compatibility, concurrent enqueue/drain, Unicode,
spaces, literal percent signs, long missing paths, working directories, flags,
and URI rejection, deterministic owner election, non-document exclusion, and
pending-request retention across owner loss or consumer registration. They can run through `cargo test --manifest-path
src-tauri/Cargo.toml` or directly with `rustc --edition 2021 --test` because this
module uses only the standard library.

`tests/e2e/native-open-queue.test.ts` has six passing Chromium cases using mocked
Tauri IPC: startup batches, warm batches, overlapping notifications, main-close
owner promotion, a cold replacement consumer, and print/preview exclusion. These
establish the frontend event/getter integration. The mock models owner election;
the Rust unit tests independently exercise the production selector.

Unit tests and mocked IPC do not establish OS association or actual native
window-lifecycle behavior.
T05 remains open until packaged Windows/macOS tests verify multiple files on
cold/warm startup, main-close owner promotion, frontend ordering, single-instance
focus, and unchanged source
bytes. Native filesystem grant boundaries and read-only/conflict handling remain
separate acceptance work.

Rollback must restore the host and frontend event/getter pair together.
