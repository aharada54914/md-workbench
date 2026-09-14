# Native Windows reproduction

`MDW Windows native reproduction` builds a real Tauri release executable and
opens synthetic LF/CRLF/BOM+CRLF Japanese documents on `windows-2022`. It does
not use the Vite application, Tauri mocks, Wine, or a fabricated Windows label.
The x64 release is built once and transferred by same-run Actions artifact to
Windows Server 2022 and actual Windows 11 ARM. Each OS job installs
checksum-pinned upstream MerMark 0.7.3. On Server, each application performs
30 process-cold and 50 warm document opens.

## Actual Windows UI compatibility

Both OS jobs also run standard UI Automation against the packaged applications.
Three disposable LF/CRLF/BOM+CRLF documents must expose their Japanese heading
and end marker, produce a nonblank OS heading capture and keep original bytes.
The fork additionally switches isolated preview on/off, appends Japanese and
emoji through CodeMirror and saves through normal Ctrl+S. Actual saved bytes
must equal the original source plus the suffix, including BOM/newlines and
unknown syntax. These checks use no Tauri or filesystem mocks.

Windows 11 diagnostic run [34858136433](https://github.com/aharada54914/md-workbench/actions/runs/34858136433)
passed all three formats with the previously built release SHA256
`47cf8cdc66d0ec81e402e34aad06b2360b1ee55b0f72ada8b6d1ed4572cd51b6`.
The normal workflow rebuilds the current source; the historical binary predates
the save-conflict fix #44 and must not be used as evidence for that fix.

Fresh hosted Windows 11 images displayed Microsoft-account and Search overlays.
The harness may send a normal bounded window-close request only to these exact
named, verified Windows system owners. It supplies no credentials, kills no
system processes and changes no policy, registry, account, ACL or runtime.
It clicks only an unobscured owned caption (native hit test), and refuses all
keyboard input unless the exact document window is foreground. Hidden Tauri
single-instance windows are excluded. UIA pressed buttons use TogglePattern.

The initial CDP-based Windows 11 trials failed for fork and upstream. A
lower-privilege diagnostic launch also failed and is not promoted. The accepted
UI compatibility checks do not need a debug port or a token-changing launcher.
Native preview toggling is not a test of iframe IPC denial; browser negative
tests cover that boundary separately. Unicode injection is not an IME test.

The observer connects to the actual WebView through a loopback CDP endpoint,
enabled only in test child-process environment. It checks a visible heading and
end-of-body, font readiness, platform CJK font glyph counts, unobscured heading
geometry, a nonuniform captured heading image, and a completed renderer-frame
screenshot. Cold trials fail if the previously owned process cannot be stopped.
Only exact owned PID trees on disposable GitHub-hosted runners are terminated.

The Python observer samples the explicitly launched process tree, including
WebView subprocesses, using the existing sampler with PID creation-time checks.
`samples.jsonl` contains working-set/private byte observations and errors.
Missing samples are not zeros. Input document hashes must remain unchanged.

## Artifacts and interpretation

- `native-results.json`: per-trial result and failures, build hash, environment.
- `cold-N/` and `warm-N/`: process samples, first observation and memory summary.
- `native-summary.json`: type-7 P50/P95 by fixture hash and mode, never pooled
  across different input encodings. Small groups retain their sample counts.
- `latest-frame.png`: synthetic document only, not a desktop/user screenshot.
- `native-ui-*/ui-results.json`: UI outcomes, exact-save hash, OS, architecture
  and binary hash; heading PNGs show synthetic documents only.

Windows Server 2022 CI is **not Windows 11 physical-machine acceptance**.
The Windows 11 ARM runner executes x64 under emulation, not on a Windows 11 x64
physical machine. Its three-format UI suite is separate from Server's 80 CDP
opens and supplies no comparable performance percentiles. The
CDP observer and memory observer add overhead, and cold sampling starts after
process launch. These are diagnostic upper bounds and process-memory samples,
not precise native present events or uninstrumented product benchmarks.
Shared working-set pages may be counted more than once. No cache flush/reboot,
power-policy changes, antivirus exclusions, AI calls or diagram-editor launch
are performed. Glyph evidence is not a complete Japanese IME test.

T03 remains open pending the agreed same-fixture 30/50 accepted observations,
VS Code comparison and complete Windows 11 x64 environment/IME acceptance.
The first run `34790461175` passed 80 opens in each real application before
the stricter glyph/memory checks were added; do not attribute later checks to it.

Run through a PR touching workflow/build inputs. No signed release is published.
Revert this PR to remove the diagnostic workflow; application configuration and
normal runtime do not acquire a CDP port.
