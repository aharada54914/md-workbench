# T03 / R16・R17 — process-tree measurement harness

Related: #13 / Epic #3. T01 source and fixture basis: PR #35,
`c5aecc311f5295e872002309dcf72cfd96a8ad84`.

## What this implements

One explicit OS-open request per trial, render observations supplied by an observer,
process-tree memory samples with per-process identity, failure-preserving raw JSONL,
and grouped P50/P95 summaries. It does not claim a benchmark result merely because
the harness tests pass. No application source, production dependency, public release
or user's settings are changed by this PR.

`psutil==7.2.2` and `Pillow==12.3.0` are measurement-only Python dependencies. Windows records working set
and private bytes separately; Linux records RSS. macOS records RSS and physical
footprint as separate metrics using public `proc_pid_rusage(RUSAGE_INFO_V0)`.
Keep OS metrics separate. Summed working set/RSS can double-count shared pages.
The current peak is over the startup observation interval, not steady-state memory.

### macOS physical footprint

`macos_memory.py` reads `ri_phys_footprint` from public libproc, with the V0 layout
declared by the macOS SDK. Apple describes this API in
[Profile and optimize your app's memory](https://developer.apple.com/videos/play/wwdc2022/10106/?time=427).
It does not use private Mach APIs, obtain a task port, elevate privileges, or replace
a denied footprint with RSS. Per-process raw rows preserve `physical_footprint_bytes`
and native start/exit identity; the tree metric is named
`summed_physical_footprint_bytes`. This sum is **not** unique application memory or
an OS coalition measurement. Permission/API failure, native exit, changed native
identity, or a changed creation time before/after reading makes that sample incomplete.
Rows and numeric errno remain in raw data; incomplete samples have no totals.

Use a dedicated benchmark account/profile and generated repository fixtures for real
app comparisons. Record macOS build, CPU/RAM, architecture/Rosetta mode, WebKit runtime,
display and app conditions. Launch the actual `.app/Contents/MacOS/...` executable
with `measure.py record`, using the same argv/fixture contract above. Do not substitute
`open -a`, which may forward the request and exit. WebKit/XPC services parented by
launchd may be absent from descendant discovery: verify explicitly supplied warm
root PIDs against the process view and report remaining coverage as unknown. No
global process-name scan or automatic coalition discovery is implemented.

`native_memory.py --pid PID --out DIRECTORY` also uses this adapter on macOS, but is
a bounded 120-second diagnostic observer with a 50 ms interval. Its `memory.json`
lacks formal app/fixture/machine metadata and must not be pooled as a benchmark trial.
The macOS native frame observer is still absent; manual markers remain diagnostic
and never qualify for precise startup-latency comparisons.

## Setup and one trial

Run on the same real desktop for upstream MerMark, VS Code without extensions,
VS Code with equivalent functionality, and the fork. Use a release build for each.
CI runners, dev servers and debug installers are not the performance comparison.

```powershell
python -m pip install -r scripts/benchmark/requirements.txt
python scripts/generate_mdw_fixtures.py --out C:/mdw-bench/fixtures --large
Copy-Item docs/md-workbench/benchmark/metadata.example.json C:/mdw-bench/machine-app.json
```

Replace every `REPLACE` field with the measured machine/OS/WebView/app conditions.
Use a machine alias instead of a personal name. An unedited template is rejected.
For a cold **process** launch, first close every process of the measured app:

```powershell
python scripts/benchmark/measure.py record `
  --metadata C:/mdw-bench/machine-app.json `
  --fixture C:/mdw-bench/fixtures/core-ja.md `
  --asset C:/mdw-bench/fixtures/assets/pixel.png `
  --asset C:/mdw-bench/fixtures/assets/box.svg `
  --out C:/mdw-bench/trials/fork-cold-001 --mode cold-process `
  -- "C:/path/to/md-workbench.exe" "{fixture}"
```

The command is an argv array, not a shell string. `{fixture}` must be a separate
argument. Use the actual GUI executable for cold launches, not a launcher that
forwards to an existing process. Existing instances of the same executable are
rejected. The harness never kills the application, clears caches, reboots, installs
VS Code extensions or changes power/antivirus settings for the operator.

For `warm`, keep the app running and specify its actual root process ID with
`--root-pid`; repeat the open request for the same fixture. Extra `--root-pid` values
can identify independently parented helpers. Descendants, including WebView children,
are discovered and retained if reparented; `(pid, creation time)` protects against
PID reuse. This is sampled observation: very short-lived or undiscovered detached
helpers can be missed. Verify the tree against the OS process view.

`cold-cache` additionally requires `--reboot-evidence` describing the preceding
reboot/cache condition. Merely restarting the app must be called `cold-process`.

## T0 / T1 / T2 and observer contract

- T0: `time.monotonic_ns()` immediately before the OS process-open invocation.
  `request.json` records the same-host monotonic clock origin for that trial.
- T1 (`body`): the first frame in which the fixture body is readable.
- T2 (`viewport`): initial viewport diagrams have finished rendering. For a fixture
  without diagrams it may equal T1. It may never precede T1.

The sampler must run separately from the observer. A native frame observer should
record the frame's timestamp on this same monotonic clock and atomically publish it:

```powershell
python scripts/benchmark/measure.py mark --out C:/mdw-bench/trials/fork-cold-001 `
  --stage body --time-ns FRAME_TIMESTAMP --evidence frame-001
python scripts/benchmark/measure.py mark --out C:/mdw-bench/trials/fork-cold-001 `
  --stage viewport --time-ns FRAME_TIMESTAMP --evidence frame-002
```

`FRAME_TIMESTAMP` is the actual integer timestamp supplied by the observer, not a
sleep duration. `--evidence` identifies the saved frame/observation locally. Keep
screenshots of user documents out of the public repository. Marker publication is
atomic and exclusive: repeated observations cannot overwrite the first marker.
The marker clock must match the recorder's clock and fit inside the trial interval.

For an initial manual diagnostic, omit `--time-ns`, keep `observer: manual`, and
emit the two marks from another terminal when the relevant content is visible.
**This includes operator reaction delay.** Manual trials never become eligible for
precise latency comparison, regardless of sample count. Window creation, process
existence and arbitrary sleeps are not substitutes for readable-frame observations.

### Native Windows screen observation

`windows_frames.py` can observe any of the three applications using reference
regions from a fully rendered **synthetic** fixture. It captures only specified
rectangles inside the target foreground client window, validates window identity
before and after capture, and refuses rectangles extending outside it. It does not
capture the entire desktop or save each captured frame. The reference images and
per-probe timestamp/difference records remain local.

First open the fixture normally, fix the window position/size/scale, and choose
small distinctive content rectangles: readable body text for T1, and the last
expected viewport diagram for T2. Avoid blank backgrounds, scrolling regions,
cursors and animations. Capture each reference (the default three-second delay
lets you focus the application after running the command):

```powershell
python scripts/benchmark/windows_frames.py reference --pid APP_PID `
  --region 20 100 400 150 --out C:/mdw-bench/body.png
python scripts/benchmark/windows_frames.py reference --pid APP_PID `
  --region 20 300 400 200 --out C:/mdw-bench/viewport.png
```

These rectangle coordinates are examples; select actual content within your
application client area. Do not use a reference containing an unrelated document.
Set `observer: screen-sampled` in the trial metadata and describe the regions.
Start the observer in another terminal just before the `record` command:

```powershell
python scripts/benchmark/windows_frames.py observe --out C:/mdw-bench/trials/fork-cold-001 `
  --body-reference C:/mdw-bench/body.png --body-position 20 100 `
  --viewport-reference C:/mdw-bench/viewport.png --viewport-position 20 300
```

The observer gets the actual root PID/creation time from the recorder's atomic
`request.json`. It requires the target app to be in the foreground. Exact pixel
matching is the default; a limited `--max-difference` tolerance of 0–5 mean RGB
units may be explicitly configured. Uniform blank references are rejected.
The observer records capture duration, cadence, difference, reference hashes and
region geometry. Failed matches time out instead of becoming successful zeroes.
The reference hashes/tolerance/cadence form part of summary grouping.

These measurements are **sampled upper bounds including capture overhead**, not
exact renderer-event timings. The summary preserves that distinction. Use the same
observer conditions across trials, inspect reference quality, and record any
foreground obstruction. A completed reference region is only evidence for that
region: choose all meaningful initial-viewport content when judging T2. A native
renderer event adapter may still supply `instrumented-frame` for higher precision.

## Raw data and comparison

Each trial creates an exclusive directory with `request.json`, `samples.jsonl`,
`result.json`, marker files and the launcher log. Samples contain root/child PID,
creation time, names, per-process memory, totals and explicit collection errors.
Permission failure, missing frame, changed input bytes, cancellation and exited trees
are recorded as failed/incomplete trials. They are never converted into zero latency.
Schema 2 records the executed argv, resolved executable, working directory, host
platform/architecture, collection method/version and sample interval. Local paths in
these records are reproducibility evidence; inspect them before publication.
Memory peaks use only complete samples. A failed trial may retain those diagnostic
peaks, but is excluded from successful statistics; a missing metric is never zero.

```powershell
$results = (Get-ChildItem C:/mdw-bench/trials/*/result.json).FullName
python scripts/benchmark/measure.py summarize --out C:/mdw-bench/summary.json $results
```

Groups require identical declared machine conditions, app version/configuration,
fixture/asset hashes, observer and launch mode. Do not pool different platforms or
VS Code extension configurations. The report includes attempted/success/failed
counts. Schema, memory method, architecture and sampling interval also separate
groups. Existing schema 1 results remain readable in their own groups and never mix
with schema 2 footprint results. The report includes metric names/units,
failure reasons, and linearly interpolated P50/P95
(type 7). Defaults require 30 successful cold or 50 successful warm trials.
Duplicate trial IDs are rejected. Failed trials remain in the denominator and
failure list; all-failed groups have null percentiles, not fabricated measurements.

Start with the T01 fixture corpus, then use its 100 KiB/10 MiB and ten-diagram inputs.
Supply referenced assets with repeated `--asset` flags so byte changes invalidate
comparisons. F04 maximum inline-image capacity is still a product-scope decision;
do not invent a supported capacity from an arbitrary stress input.

## Verification and remaining acceptance

`python -m unittest discover -s scripts/benchmark -p 'test_*.py'` covers actual
CLI/process sampling on a synthetic test process, atomic-marker duplicate rejection,
timeouts, PID reuse, retained WebView children, access-denied memory, statistics,
metadata grouping, insufficient samples and manual-observer exclusion.
These are **tooling tests with artificial inputs**, not real app performance data.
The test host is the synthetic warm root, avoiding nested test PID-namespace ambiguity.
CI runs the tooling tests on Windows Server 2022, Ubuntu 24.04 and macOS 15.
The macOS suite compiles a small C probe against the installed public SDK to check
the ctypes structure size/offsets, reads its own process and an explicitly created
synthetic child, and verifies failure after child exit. Injected tests cover errno,
unavailable API, PID/native identity changes, missing metrics and raw failure files.
Native macOS tests are explicitly skipped on other operating systems. These tests
do not prove tree completeness for real GUI applications or benchmark acceptance.
The frame suite additionally tests region bounds, exact matching and marker
immutability, and runs real native capture/observer CLI against a synthetic Tk
window on Windows. That native case is explicitly skipped on Linux.

Pending: Windows 11 desktop and measurement conditions, calibrated reference regions,
30/50-trial real application comparison, macOS frame observation and real application
footprint/tree coverage. No startup
or memory target is declared achieved. Keep #13 / Epic #3 open until real measurement
acceptance is supported. Rollback removes the added tooling/docs/workflow; there are
no application or system settings to undo.
