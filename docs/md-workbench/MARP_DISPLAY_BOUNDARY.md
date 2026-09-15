# Marp display boundary

This advances T04; it does not complete the filesystem broker or certify all
Marp/native platforms. Authored Markdown stays unchanged. Sanitization applies
only to the rendered display/export copy.

## Rendering

Live preview, presentation and standalone HTML use `buildStandaloneHtml`.
The default renderer disables authored raw HTML. An inert template filters the
rendered body to slide-layout, text/table, SVG and math nodes, including Marp's
`foreignObject`, generated header/footer/background figures and MathJax wrapper.
Scripts, nested frames, form controls, metadata, event handlers and external or
navigable links are removed. Only an SVG `use` fragment reference is retained.
Image `src` permits supported data-image syntax with a 12 MiB URI bound; rejected
images retain an explicit blocked-image alt text. This is not a general decoded
image/pixel budget for authored CSS or every Markdown reference form.

CSS is kept as a display copy. Its literal less-than signs are escaped before
insertion into the style raw-text element, preventing stylesheet termination.
A CSP before all style/body content blocks scripts, external images/fonts/styles,
connections, nested frames, objects, base changes and forms. Inline CSS and data
images/fonts are the only resource allowances. CSS URLs remain subject to CSP;
a browser can report a blocked request event without issuing a network request.

Both previews use an iframe with `sandbox="allow-same-origin"` and no script,
popup, download, form or top-navigation allowance. Same-origin access lets only
the trusted parent control slide selection and bind the live scroll container.
The live iframe fills the pane and uses one internal scroll container, which is
bound directly to editor synchronization after each frame load. Wheel/touch intent
and the full scroll range of long decks therefore share the same container.
Document changes detach synchronization and replace the iframe so old content
is removed before the image payload lease is released. Its fixed viewport avoids
resize feedback from viewport-relative author CSS. Standalone
HTML has the same sanitization and CSP when opened outside the iframe.

No script from Marp's generated browser polyfill is enabled. Dynamic autosizing
and native WebKit layout remain unverified; current checks establish Chromium
behavior only. Author CSS can affect the slide document, including layout and
resource consumption, and is not a promise of faithful rendering for every theme.
The existing HTML export destination write path is unchanged and still needs the
transactional Save/broker work.

## Verification

- Real Marp unit coverage retains two slides, SVG foreignObject, MathJax paths,
  embedded background figures, header/footer, and data image syntax.
- Negative unit cases remove active markup, external navigation and event
  attributes and prevent closing the stylesheet raw-text element.
- Actual Chromium mounts the live and presentation components and opens their
  generated HTML directly. It checks visible slides/math, presentation navigation,
  internal scrolling, and blocked authored images/links/raw HTML.
- A deck above 32,768 pixels verifies editor-to-preview scrolling to the end,
  actual preview wheel takeover, and synchronous old-frame destruction on replacement.
- CSS import/background attempts must fail specifically with CSP and never reach
  network interception; a live image in the unprotected parent proves the request
  collector can detect a real attempt. The test does not credit routing's abort
  as product protection.
- Separate standalone checks exercise stylesheet termination, active SVG,
  refresh metadata, nested frames and event handlers while a data PNG displays.

Native/owned image-read byte limits and lifetime accounting are separate from
this rendering boundary. No new filesystem or window capability is granted.
