# T04 isolated preview boundary

This is an incremental implementation of #14, not completion of E1.

The explicit **Isolated read-only preview** action opens a `srcdoc` iframe with an
empty sandbox: no script, same-origin, navigation, forms, popups or downloads.
The frame has a deny-by-default CSP, no IPC bridge, no message handler, and only
receives a sanitized display copy of Markdown. It cannot read the parent DOM or
call its Tauri API. Raw source is not serialized from the lossy preview.

The sanitizer constructs a new allowlisted DOM from an inert template. It drops
active elements, all authored CSS, external URLs, SVG/foreignObject, and active
data images. Raster data images are bounded by encoded size. Links are inert.
Math and diagrams currently use source fallback; an editor/provider is never
created by the isolated frame. Local/remote images needing host reads are shown
as blocked, not silently fetched.

The existing editor stays mounted behind the preview so opening/closing the
preview does not discard its undo history. Consequently this action is **not**
yet the default read-only file-open pipeline: existing host watchers and editor
work may have run before the action. Do not equate the frame's boundary with
whole-application read-only acceptance. T05/T06 must provide that lifecycle.

Release CSP now denies external network resources, inline scripts, objects,
forms and base changes. Development WebSocket access is a separate CSP. Mermaid
uses strict rather than loose mode. This is defense in depth, not a replacement
for an isolated Mermaid/draw.io provider.

## Remaining gates

- The existing trusted UI still has broad filesystem permissions. T05's backend
  broker must replace them without breaking explicit file dialogs/associations.
  These permissions are not passed into the opaque sandboxed preview.
- draw.io has no provider yet; do not add `allow-same-origin` or `allow-scripts`
  to this frame to accommodate it. T16 needs a separate authenticated context.
- External-image consent UX and authorized local-image brokering remain open.
- Windows Server native CSP compatibility, default read-mode lifecycle and
  Japanese IME acceptance must be verified before closing the parent task.

## Verification

`src/__tests__/utils/isolated-preview.test.ts` covers script, event, SVG,
foreignObject, external image/CSS, form, navigation and data-image fixtures.
`tests/e2e/isolated-preview.test.ts` verifies real Chromium opaque origin,
unavailable Tauri globals, blocked fetch and zero outbound fixture requests.
CI runs the full unit/browser suites on Linux and Windows. Native Tauri builds
remain a separate check; a browser test is not a Windows desktop test.

Rollback: revert the implementation PR. No source migration or asset deletion.
