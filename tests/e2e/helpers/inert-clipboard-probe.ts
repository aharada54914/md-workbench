import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { NodeSelection, Plugin } from '@tiptap/pm/state';
import { createInertClipboardHandlers, consumeEmptyClipboardSlice } from '../../../src/utils/inert-clipboard';

/** Isolated real PM boundary, not the application's image provider/OS clipboard. */
export async function runInertClipboardProbe() {
  const activeAdoptions: string[] = [];
  const originalAppend = Node.prototype.appendChild;
  Node.prototype.appendChild = function<T extends Node>(child: T): T {
    if (this.ownerDocument === document && child instanceof Element &&
        (child.matches('img[src]') || child.querySelector('img[src]'))) {
      activeAdoptions.push(child.outerHTML);
    }
    return originalAppend.call(this, child) as T;
  };
  const ImageView = Image.extend({ addNodeView() {
    return () => {
      const dom = document.createElement('div');
      dom.draggable = true;
      dom.textContent = 'Inert image';
      return { dom };
    };
  } });
  const cases = [];
  try {
    for (const kind of ['copy', 'cut', 'missing-copy', 'missing-cut', 'paste', 'empty-paste',
      'missing-paste', 'composing-paste', 'internal-drop', 'external-drop']) {
      const host = document.body.appendChild(document.createElement('div'));
      const rawSrc = `images/__clipboard_sentinel__-${kind}.png`;
      let observedPaste = 0;
      const editor = new Editor({
        element: host,
        extensions: [StarterKit, ImageView],
        content: { type: 'doc', content: [
          { type: 'image', attrs: { src: rawSrc } },
          { type: 'paragraph', content: [{ type: 'text', text: 'tail' }] },
        ] },
        editorProps: {
          handleDOMEvents: createInertClipboardHandlers(),
          handlePaste: (_view, _event, slice) => consumeEmptyClipboardSlice(slice),
        },
      });
      editor.registerPlugin(new Plugin({ props: { handleDOMEvents: {
        paste: () => { observedPaste++; return false; },
      } } }));
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
      let before = editor.getJSON();
      const data = new DataTransfer();
      let event: ClipboardEvent | DragEvent;
      if (kind.endsWith('drop')) {
        if (kind === 'internal-drop') {
          editor.view.dom.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
        } else {
          data.setData('text/html', '<img src="/__clipboard_sentinel__-external.png">');
        }
        const target = editor.view.dom.querySelector('p')!.getBoundingClientRect();
        event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data,
          clientX: target.right - 2, clientY: target.bottom - 2 });
      } else {
        if (kind === 'paste' || kind === 'composing-paste') {
          data.setData('text/html', '<p><strong>rich</strong></p><img src="/__clipboard_sentinel__-paste.png" srcset="/__clipboard_sentinel__-srcset.png 2x">');
        }
        if (kind === 'empty-paste') data.setData('text/html', '<meta name="empty">');
        if (kind === 'composing-paste') {
          editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          // PM compositionstart can delete its selected node before any paste.
          before = editor.getJSON();
        }
        const type = kind.endsWith('paste') ? 'paste' : kind.endsWith('copy') ? 'copy' : 'cut';
        event = new ClipboardEvent(type, { bubbles: true, cancelable: true,
          clipboardData: kind.startsWith('missing-') ? null : data });
      }
      editor.view.dom.dispatchEvent(event);
      // Give actual browser resource selection/fetch tasks a chance to run.
      await new Promise(resolve => setTimeout(resolve, 100));
      cases.push({ kind, rawSrc, before, model: editor.getJSON(), html: data.getData('text/html'),
        prevented: event.defaultPrevented, observedPaste, liveImages: host.querySelectorAll('img[src]').length });
      editor.destroy();
      host.remove();
    }
    return { cases, activeAdoptions };
  } finally { Node.prototype.appendChild = originalAppend; }
}
