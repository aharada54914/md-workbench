import { markdownToHtml } from './markdown-converter';
import { decodeSafeHtmlSource } from './safe-html';
import { decodeMath } from './math';

export const PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const tags = new Set('p div span strong em b i s del u br hr a img details summary h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code table thead tbody tfoot tr th td sup sub'.split(' '));
const drop = new Set('script style iframe frame object embed svg math link meta base form input button textarea select audio video source template'.split(' '));
const raster = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i;

/** An inert display copy. Never serialize this lossy representation back to disk. */
export function sanitizePreviewHtml(html: string): string {
  // A template is inert while parsing (including images); do not attach raw DOM.
  const template = document.createElement('template');
  template.innerHTML = html;
  const output = document.createElement('div');
  const append = (node: Node, parent: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent ?? ''));
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.localName.toLowerCase();
    if (drop.has(tag)) return;
    if (!tags.has(tag)) {
      for (const child of node.childNodes) append(child, parent);
      return;
    }
    const clean = document.createElement(tag);
    // No href/srcset/style/event/ID/name or data-* pass-through, hence no
    // navigation, CSS fetch, DOM clobbering, or privileged editor node contract.
    for (const attr of ['alt', 'title']) {
      if (node.hasAttribute(attr)) clean.setAttribute(attr, node.getAttribute(attr)!);
    }
    if (tag === 'details' && node.hasAttribute('open')) clean.setAttribute('open', '');
    if (tag === 'img') {
      const src = node.getAttribute('src') ?? '';
      if (src.length <= 8_000_000 && raster.test(src)) clean.setAttribute('src', src);
      else {
        const notice = document.createElement('span');
        notice.textContent = `[Image blocked: ${node.getAttribute('alt') || 'external or active image'}]`;
        parent.appendChild(notice);
        return;
      }
    }
    for (const attr of ['colspan', 'rowspan']) {
      const value = node.getAttribute(attr);
      if ((tag === 'td' || tag === 'th') && value && /^[1-9]\d{0,2}$/.test(value)) clean.setAttribute(attr, value);
    }
    for (const child of node.childNodes) append(child, clean);
    parent.appendChild(clean);
  };
  for (const node of template.content.childNodes) append(node, output);
  return output.innerHTML;
}

export function buildIsolatedPreviewDocument(markdown: string): string {
  const template = document.createElement('template');
  template.innerHTML = markdownToHtml(markdown);
  for (const block of template.content.querySelectorAll('[data-safe-html-block]')) {
    const replacement = document.createElement('div');
    replacement.innerHTML = sanitizePreviewHtml(decodeSafeHtmlSource(block.getAttribute('data-safe-html-block') ?? ''));
    block.replaceWith(replacement);
  }
  // No lazy diagram editor or math renderer is started by this context.
  // Source fallback is explicit until isolated render providers are accepted.
  for (const block of template.content.querySelectorAll('[data-type="mermaid"], [data-type="katex-block"], [data-type="katex-inline"]')) {
    const replacement = document.createElement('pre');
    replacement.textContent = block.hasAttribute('data-math-source')
      ? decodeMath(block.getAttribute('data-math-source')!)
      : block.hasAttribute('data-code') ? decodeSafeHtmlSource(block.getAttribute('data-code')!) : block.getAttribute('code') ?? block.textContent;
    block.replaceWith(replacement);
  }
  return previewDocument(sanitizePreviewHtml(template.innerHTML));
}

/** Bounded large-file pages are plain text, with no Markdown/HTML parser. */
export function buildIsolatedSourceDocument(source: string): string {
  const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return previewDocument(`<pre>${escaped}</pre>`);
}

function previewDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><style>body{font:16px/1.65 system-ui,sans-serif;margin:24px;color:#182230;background:#fff;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#f3f5f7;padding:12px}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ccd3dc;padding:6px}blockquote{border-left:3px solid #ccd3dc;margin-left:0;padding-left:16px}</style></head><body>${body}</body></html>`;
}
