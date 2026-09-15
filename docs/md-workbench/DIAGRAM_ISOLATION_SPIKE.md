# Synthetic diagram isolation spike (T04 experiment)

This opt-in fixture tests the native boundary before a draw.io runtime is introduced. It is **not T04 or T16 acceptance**, an editor, an image/XML validator, a safe Save implementation, or a draw.io integration. No original document is used. Normal preview, shipping capabilities and persistence are unchanged.

## Build and observe

```
pnpm tauri build --no-bundle --features diagram-isolation-spike
```

Launch the resulting binary with `--diagram-isolation-spike`. Both the nondefault compile feature and flag are required. Default builds do not compile/register the fixture protocols, launcher or receipt hook. The dedicated workflow `.github/workflows/mdw-diagram-isolation.yml` first builds the default binary and checks that the flag alone creates no fixture. It then builds the opt-in binary and runs `scripts/diagram-isolation/windows.mjs` against actual WebView2 on disposable hosted Windows 2022. CDP is injected only through the owned test process environment. No release configuration enables CDP.

The runner writes `report.json` even on observation failure, exits nonzero on failed required observations, records the binary and fixed asset SHA-256 hashes and actual origins, and uploads artifacts with `if: always()`. It kills only its own process tree. The invoke key remains in memory; session nonce, HTML and source text are not logged. `native-receipts.log` contains at most 32 native-denial receipts with constant command names.

Local checks: `node --test scripts/diagram-isolation/protocol.test.mjs` and `cargo test --manifest-path src-tauri/Cargo.toml --lib --features diagram-isolation-spike diagram_spike`.

## Native containment

The only fixture window uses a native random `diagram-spike-…` label. It is never registered as an editor and does not match `main` or `window-*` capability selectors. The global custom-command guard derives the actual caller identity and rejects it before command dispatch; the feature hook records that rejection, without changing the decision. Plugin ACL remains independent.

Two compiled-in schemes serve distinct fixed origins: wrapper `mdwdiagramhost` and child `mdwdiagramfixture`. Each handler checks actual protocol context WebView label, live session, GET, exact host/path, absence of query, and a fixed route/MIME allowlist. There is no file mapping, generic HTML/URL argument, redirect, external resource, CORS wildcard or grant API. HTML interpolation contains only native random hex and constant origins. Assets have `no-store`, `nosniff` and separate restrictive CSP headers.

The wrapper alone can frame the exact child origin. Both forbid network connections, images, fonts, workers, objects, base URLs and forms. Scripts are external self assets. The child iframe is cross-origin with only `allow-scripts allow-same-origin`; this does not change the ordinary preview's empty sandbox. Native navigation permits only the two fixed documents, popups and downloads are denied, and drag/drop is disabled. A denied navigation, host or child document reload, destruction, or a native 10-second asset deadline retires the fixture. JavaScript listeners retire after one exchange, on timeout or pagehide. Late messages cannot modify a completed candidate. The deadline bounds this experiment; it is not a host scheduler or resource reclamation proof.

## Synthetic protocol

JSON string envelope: `v`, `session` (native 128 random bits encoded as hex), `seq`, `kind`; only `load` and `candidate` additionally carry `text`. No XML/HTML interpretation occurs. Host expects `ready:0`, sends `load:1`, receives `candidate:2` or `cancel:2`. Child expects `load:1` or `cancel:1`. Unknown fields/types, invalid nonce, unexpected sequence, nonstring payload and malformed JSON retire the selected peer. Foreign source WindowProxy or origin is ignored before accessing/parsing data.

Limits: 64 KiB UTF-8 envelope with a cheap UTF-16 precheck, 32 KiB UTF-8 text, 32 accepted messages, 256 KiB cumulative accepted bytes per receiver, 10-second deadline. Fixed one-exchange output is much smaller. These checks run after browser message delivery; they do not prevent the browser allocating an adversarial structured-clone payload or prove separate OS processes. Nonce authenticates the session, not the honesty of code within it. Upstream draw.io does not promise this envelope/nonce; a future integration requires its own reviewed adapter.

## Evidence and deliberately unmeasured boundaries

Actual origins must be distinct, nonopaque, exact values in both `location.origin` and `MessageEvent.origin`. Windows is expected to use `http://mdwdiagramhost.localhost` / `http://mdwdiagramfixture.localhost`; macOS/Linux use custom URL shapes but might serialize opaque origins. A `null`, collapsed/equal or undeliverable exact target origin is unsupported, never accepted by nonce fallback, wildcard targetOrigin or a local HTTP server.

**No OS GUI result has been measured when this change is authored.** Native unit compilation on macOS and pure Node tests do not establish WebView2/WKWebView/WebKitGTK behavior. Windows execution is pending the dedicated workflow; macOS and Linux need native observers. The fixture contains no draw.io bundle and makes no version, license, offline edit, compressed XML, rendering or resource-save claims.

The first Windows observer requires the real roundtrip, cross-origin parent-DOM denial, actual native custom-IPC denial receipts from wrapper and child, plugin ACL rejection receipts, CSP connect/inline-script violations, popup denial and reload retirement. Missing transport, malformed-argument errors and CSP-blocked requests are not native IPC rejection receipts. The foreign-main protocol request may be blocked by main CSP before reaching native, or have its response hidden by CORS; this is recorded separately, with native unit ownership tests as unit evidence only.

The report's `passed_measured_subset` is deliberately narrower than complete boundary acceptance. Missing observations are retained in `missing`: native download callback receipt, all network vectors/socket capture, destroy/recreate, main protocol receipt when hidden by CSP/CORS, and macOS/Linux native runtime behavior. Popup page-count observation is not by itself the native denial callback receipt. Child plugin transport is not independently exercised by this first observer (top WebView ACL receipts are). Further native observers are required before issue completion. Any unsupported exact-origin or required-transport result makes this workflow fail; it cannot become a successful subset by silently omitting that check.

Approved representation ADR2 is unchanged. T16's real offline runtime pin/inventory/license audit, upstream protocol adapter, edit/cancel lifecycle, XML/resource limits and security/save acceptance remain separate work.
