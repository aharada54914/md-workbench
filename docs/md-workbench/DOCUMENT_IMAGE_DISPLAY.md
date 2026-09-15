# Document image display provider

This is the current-editor byte and DOM display boundary for T04/T05. It does not
by itself complete the editor cutover: inert HTML parsing, serialization,
clipboard/drag handling, SafeHtmlBlock integration and actual browser verification
are separate integration requirements. Markdown, exports and model attributes
retain authored source strings. No native or destination-write authority is added.

## Integration contract

`createDocumentImageDisplay({ getContext, beforeRelease?, subscribeContext? })`
creates one provider per editor. Share it between `SafeImage.configure({ provider })`
and SafeHtmlBlock. Context is `{ owner, path, revision }`: the live document owner,
current document path or null, and a transient authority revision number. The
revision must change when native document authority is replaced/reselected. Call
`refresh()` synchronously when those properties change, or provide a subscription
that does so and returns its unsubscribe function. Owner closure must notify this
lifecycle too; a byte-store liveness check alone cannot remove an already displayed
DOM image. Context is captured before work and checked after every native await.

`attach(img, authoredSource, onStatus?)` removes src/srcset, returns a disposable
binding, and reports loading, ready (browser load), or unavailable. SafeHtmlBlock
must remove active source attributes in an inert document **before** adopting the
element; attaching after a raw image was made active cannot undo an earlier fetch.
`dispose()` invalidates pending results and removes the src synchronously. It calls
`beforeRelease(url)` and waits for its optional promise before revoking the URL.
For Vue previews, the callback should hide a matching preview and return `nextTick()`
so its image DOM has been removed. Cleanup still revokes after callback rejection.
An unresolved callback retains a bounded URL reservation instead of releasing its
budget while the URL remains alive. Do not expose these Blob URLs as navigations,
objects, downloads or exported/model sources.

Failures, including capacity exhaustion and browser decode errors, are terminal
for that binding/context. Repeated refresh with unchanged context does not retry.
An authority/context revision explicitly retries current bindings. DOM destruction
must dispose its binding; editor destruction must dispose the provider.

## Byte sources and restrictions

1. Read an exact authored-key snapshot belonging to the live owner. Imported bytes
   are current-document snapshots and can display an imported absolute path without
   reauthorizing that path. Another owner's snapshot is never used.
2. For `data:` accept only canonical base64 with the exact MIME allowlist below.
   Check encoded size before decoding and decoded size before Blob construction.
   Reject whitespace, noncanonical padding bits, parameters and percent encoding.
3. Otherwise accept literal `images/` or `<native-style-document-stem>.assets/`
   references with clean components. Resolve the current document READ descriptor,
   then invoke `readDocumentImageBytes(path, grantId, literalRelativePath)`. The host
   independently enforces current generation/grant, regular document, retained
   handles, containment and its fixed 8 MiB limit. Percent escapes remain literal.

There is no plugin-fs fallback, URL fetch, path-created permission, arbitrary
authored Blob URL reuse, or arbitrary absolute/HTTP/file URL load. Unsupported
sources become an unavailable image while the original model source stays intact.

PNG, JPEG, GIF and WebP use byte signatures for MIME routing. SVG must start with
an SVG document element (optional XML declaration); DTD/entity declarations are
rejected, with no XML DOM parsing. Data MIME must match the detected format. Unknown
formats are unavailable. These checks route formats; they are **not image
validation or a safe decoder**, and signature-only malformed files can reach the
browser image decoder and fail there. Encoded-byte bounds do not bound decoded
pixel memory, raster dimensions, SVG complexity or browser CPU.

SVG is used only as `image/svg+xml` in an owned Blob assigned to an HTML `img`.
SVG 2 specifies secure image processing for SVG referenced by HTML img: scripts,
interactivity and external file references are disabled in this mode. This is not
an inline-SVG sanitization guarantee. See [SVG 2 processing modes](https://www.w3.org/TR/SVG/conform.html).
No Windows/WebView2, macOS/WKWebView or Linux/WebKitGTK GUI conformance or no-network
result is claimed by the provider unit tests. The integrated product needs those
checks, including SVG script/external-reference probes, before platform claims.

## Bounds and lifecycle

Display budgets are independent from the ingress snapshot store:

| Resource | Bound |
| --- | --- |
| Encoded bytes per read/Blob | 8 MiB |
| Display encoded bytes per owner | 64 MiB |
| Display encoded bytes per window | 128 MiB |
| Bindings per provider / per owner | 128 / 128 |
| Registered bindings per window | 256 |
| In-flight or live URL reservations per owner / window | 128 / 256 |
| Concurrent read/decode jobs per window | 4 |
| Queued jobs per window | 128 |
| Literal native path length | 4096 UTF-16 code units, plus native byte/depth limits |

Each job reserves the full 8 MiB before copying a snapshot, decoding data, or
starting native descriptor/read IPC, then shrinks to actual encoded size. A
cancelled in-flight read keeps its reservation and scheduler slot until the native
promise settles. Queued cancelled jobs are removed. URL cleanup retains both its
byte and URL-count reservation through preview removal. Therefore tiny URLs with
stalled cleanup cannot accumulate without a count limit.

The totals describe encoded byte payloads, not exact JavaScript/native heap usage:
native JSON number arrays, typed-array/Blob copies, base64 strings and browser
decoder allocations add overhead. Four concurrent operations and pre-read
reservations bound the operation count; IPC cannot currently be cancelled or
interrupted. A permanently pending IPC can occupy a slot until editor/window exit.
No silent cache eviction or repeated timer retry is used. At a full budget, a small
image may be rejected because its unknown-size read reserves 8 MiB conservatively.

These limits do not make cross-window retained-byte transfer, save relocation,
restart persistence, Marp preview resources, PDF/export rendering, safe decoding,
or T10 validation complete.
