import { Node, mergeAttributes } from '@tiptap/core';
import type { createDocumentImageDisplay } from '../services/documentImageDisplay';
import { NodeSelection } from '@tiptap/pm/state';
import {
  decodeSafeHtmlSource,
  encodeSafeHtmlSource,
  safeHtmlRenderableTagSourceLines,
  safeHtmlSourceKey,
  sanitizeSafeHtml,
} from '../utils/safe-html';

interface SafeHtmlOptions {
  provider: Pick<ReturnType<typeof createDocumentImageDisplay>, 'attach'> | null;
}

export const SafeHtmlBlockExtension = Node.create<SafeHtmlOptions>({
  addOptions() { return { provider: null }; },
  name: 'safeHtmlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      raw: {
        default: '',
        parseHTML: element => decodeSafeHtmlSource(element.getAttribute('data-safe-html-block') ?? ''),
        renderHTML: attributes => ({ 'data-safe-html-block': encodeSafeHtmlSource(String(attributes.raw ?? '')) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-safe-html-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'safe-html-block', contenteditable: 'false' })];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'safe-html-block';
      dom.contentEditable = 'false';
      const raw = String(node.attrs.raw ?? '');
      const template = document.createElement('template');
      template.innerHTML = sanitizeSafeHtml(raw);
      const images = Array.from(template.content.querySelectorAll('img')).map(img => {
        const src = img.getAttribute('src') ?? '';
        // Remove resource attributes before any node is adopted by the live DOM.
        img.removeAttribute('src');
        img.removeAttribute('srcset');
        return { img, src };
      });
      dom.appendChild(template.content);
      dom.dataset.safeHtmlCursorLine = '0';
      dom.dataset.safeHtmlSourceKey = safeHtmlSourceKey(raw);

      const sourceLines = safeHtmlRenderableTagSourceLines(raw);
      const rendered = dom.querySelectorAll('p, strong, em, br, a, img, details, summary');
      rendered.forEach((element, index) => {
        if (sourceLines[index] !== undefined) {
          (element as HTMLElement).dataset.safeHtmlSourceLine = String(sourceLines[index]);
        }
      });

      const bindings = images.map(({ img, src }) => {
        const status = document.createElement('span');
        status.setAttribute('role', 'status');
        status.className = 'editor-image-status';
        img.after(status);
        const onStatus = (value: 'loading' | 'ready' | 'unavailable') => {
          status.textContent = value === 'ready' ? '' : value === 'loading' ? 'Loading image…' : 'Image unavailable';
          status.hidden = value === 'ready';
        };
        onStatus('unavailable');
        return this.options.provider?.attach(img, src, onStatus);
      });

      const rememberClickedLine = (event: PointerEvent) => {
        const target = event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-safe-html-source-line]')
          : null;
        dom.dataset.safeHtmlCursorLine = target?.dataset.safeHtmlSourceLine ?? '0';
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos === 'number') {
          editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
        }
      };
      dom.addEventListener('pointerdown', rememberClickedLine);

      return {
        dom,
        ignoreMutation: () => true,
        destroy: () => {
          dom.removeEventListener('pointerdown', rememberClickedLine);
          bindings.forEach(binding => binding?.dispose());
        },
      };
    };
  },
});
