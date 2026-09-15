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
exact labels created by the backend qualify. Print (`print-preview`), preview,
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
release. Focus-file events keep their existing contract. Tab transfer uses the separate
[delivery acknowledgement protocol](FILESYSTEM_BROKER_API.md#window-registry-and-transfer-boundary).

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


## Frontend tab-transfer acceptance (2026-09-16)

The target registers its `tab-transfer` notification listener before its initial
pending-transfer lookup. Native file opens and transfer receives share a serial
queue. Notifications supply no trusted file paths. The receiver checks that a
real, clean tab exists after the read before acknowledging success; a failed read
or existing dirty tab returns a negative acknowledgement without overwriting it.
A target edit during final registration also prevents a successful acknowledgement.

The source keeps its tab and registration while the native command awaits ACK.
After success it removes the tab only if its content, original Markdown, pending
Markdown and clean state still match the transfer snapshot. Edits during final
unregistration restore the source registration. Failure or timeout shows an error
and retains the source. This transfer does not save or serialize editor HTML.

`SplitContainer.transfer.test.ts` and `useWindowManager.test.ts` cover pending ACK,
failed completion, duplicate drags and late edits. `tab-transfer-ack.test.ts` covers
cold delivery, ignored event paths, ordered runtime delivery, failed reads,
existing clean/dirty targets, ACK races and deferred read/registration. These are
frontend tests with mocked IPC; packaged multi-window delivery remains a native
acceptance requirement.


## Windows release queue probe (prepared; native execution pending)

`scripts/benchmark/native_open_queue.mjs` adds a separate disposable-process
exercise after the existing 30 cold / 50 warm timing trials and authority probe.
It does not add observations to benchmark statistics or call the native queue
getter on the frontend's behalf. `windows_native.mjs` runs it only for the fork;
the upstream comparison and timing trial counts remain unchanged.

The fixed, exclusive fixture tree contains three independent batches, each with
Japanese/space filenames, literal `%20`, and a nested absolute path of at least
320 UTF-16 code units. LF, CRLF, BOM, unknown directive text and trailing spaces
are retained. Long-path fixture creation failure is a failure, not a substituted
short-path pass. No association, registry or filesystem policy is changed.

The probe checks:

- Cold argv `A,B,A,C` opens exactly `A,B,C` in order, ending on C.
- Warm argv appends a fresh batch in the original process; the forwarding
  process must exit successfully, without creating another document window.
- Two blank native-created editors exist before clean main receives an ordinary
  close request. After native destruction is observed, a new warm batch opens
  in the lowest numeric surviving editor, without recreating main.
- Reopening an existing document focuses its current tab without adding a
  duplicate. Each new batch's inactive tabs must also show their actual fixture
  body when selected.
- Real native READ IDs return exact fixture hashes, foreign old-main IDs remain
  denied, and the uninvolved sibling cannot look up newly delivered grants.
  An unselected sentinel receives no grant.
- `is_focused`, `is_minimized` and `is_visible` native window queries establish
  focus/restore after ingress, before the test clicks tabs. The test establishes
  a different sibling's focus beforehand and never repairs focus afterward.
  Minimized setup uses `windows_queue_state.ps1`, selecting exactly one HWND by
  the owned process PID and a temporary synthetic native title. It restores the
  title and confirms state with the native getter; product IPC permissions are
  unchanged. This setup runs only before ingress.
  DOM focus and CDP target selection are not accepted as native focus evidence.
- Original fixture and sentinel hashes are checked between phases and before
  and after terminating only this probe's owned processes, including failure
  cleanup. Hash mismatches and unreadable inputs remain in the report.

`native-fork/native-open-queue.json` records phase, ordered tabs, window labels,
PID, grant IDs, source/authorized-read hashes, path lengths, focus observations
and limitations. Bounded screenshots contain only the disposable synthetic
application windows. The existing Windows workflow uploads these artifacts on
success or failure. Five Node helper tests cover fixture bounds, exact byte
formats, invalid tab/focus witnesses and hash corruption/deletion; they do not
establish native execution success.

The first real execution is the existing `windows-2022` CDP job using the release
executable built with `tauri build --no-bundle`. This section records prepared
coverage, **not a passing Windows result**. The Windows 11 Arm UIA job does not
execute this new CDP probe. macOS/Linux, installed shell associations and the
already-enqueued-but-undrained destruction interval remain unmeasured. Closing
main before the next batch establishes owner promotion, not durable or
acknowledged queue delivery. T05 remains open.
