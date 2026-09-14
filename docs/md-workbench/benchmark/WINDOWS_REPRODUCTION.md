# Native Windows reproduction

`MDW Windows native reproduction` builds a real Tauri release executable and
opens synthetic LF/CRLF/BOM+CRLF Japanese documents on `windows-2022` and
`windows-11-arm`. The x64 release is built once on Windows Server and transferred
through a same-run, SHA-pinned Actions artifact download. It does
not use the Vite application, Tauri mocks, Wine, or a fabricated Windows label.
Each OS job installs checksum-pinned upstream MerMark 0.7.3 and repeats the
exercise. Each application performs 30 process-cold and 50 warm document opens.

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

Windows Server 2022 CI is **not Windows 11 physical-machine acceptance**. The
Windows 11 ARM job uses an actual Windows 11 desktop OS with x64 emulation,
not a Windows 11 x64 physical machine. `runner_arch`, process architecture,
OS version, image version and binary hash are retained; do not pool its timing
with Server x64 results. The compatibility job must pass before claiming Windows
11 validation. The runner labels are documented in
[GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The
CDP observer and memory observer add overhead, and cold sampling starts after
process launch. These are diagnostic upper bounds and process-memory samples,
not precise native present events or uninstrumented product benchmarks.
Shared working-set pages may be counted more than once. No cache flush/reboot,
power-policy changes, antivirus exclusions, AI calls or diagram-editor launch
are performed. Glyph evidence is not a complete Japanese IME test.

T03 remains open pending the agreed same-fixture 30/50 accepted observations,
VS Code comparison and complete Windows 11 x64 environment acceptance.
The first run `34790461175` passed 80 opens in each real application before
the stricter glyph/memory checks were added; do not attribute later checks to it.

Run through a PR touching workflow/build inputs. No signed release is published.
Revert this PR to remove the diagnostic workflow; application configuration and
normal runtime do not acquire a CDP port.
