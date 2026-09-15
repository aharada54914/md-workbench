/** Display/export copy only. Authored Markdown is never rewritten here. */
export const MARP_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// Marp uses SVG foreignObject for slide layout and SVG/MathML for mathematics.
// These nodes live only inside a script-disabled document, never in the app DOM.
const tags = new Set(('section header footer figure figcaption div span p strong em b i s del u br hr a img details summary '
  + 'h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code table thead tbody tfoot tr th td sup sub '
  + 'svg g path defs clippath rect text tspan use line circle ellipse polygon polyline '
  + 'foreignobject symbol title desc lineargradient radialgradient stop mask pattern '
  + 'mjx-container math semantics annotation mrow mi mn mo mtext mspace mfrac msqrt mroot mstyle '
  + 'merror mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover '
  + 'mmultiscripts mprescripts none mtable mtr mtd').split(' '));
const svgNamespace = 'http://www.w3.org/2000/svg';
const image = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);(?:base64,|charset=utf-8,|utf8,)/i;
const maxImageUri = 12 * 1024 * 1024;

export function sanitizeMarpBody(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  // Parsing and mutation stay in the template's inert ownerDocument.
  for (const element of template.content.querySelectorAll('*')) {
    if (!tags.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const local = attribute.localName.toLowerCase();
      if (name.startsWith('on') || ['srcset', 'ping', 'action', 'formaction', 'target', 'download', 'is', 'contenteditable', 'autofocus'].includes(name)) {
        element.removeAttributeNode(attribute);
      } else if (local === 'href') {
        // Only a generated SVG reference may resolve within this document.
        if (element.namespaceURI !== svgNamespace || element.localName !== 'use'
          || !/^#[a-zA-Z0-9_-]+$/.test(attribute.value)) element.removeAttributeNode(attribute);
      } else if (local === 'src') {
        if (element.localName !== 'img' || attribute.value.length > maxImageUri || !image.test(attribute.value)) {
          element.removeAttributeNode(attribute);
          if (element.localName === 'img') element.setAttribute('alt', `[Image blocked] ${element.getAttribute('alt') ?? ''}`);
        }
      }
    }
  }
  return template.innerHTML;
}
