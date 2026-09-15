import { expect, test } from '@playwright/test';

test('inert helpers preserve actual TipTap image models without raw resource fetches', async ({ page }) => {
  const requests: string[] = [];
  const routed: string[] = [];
  page.on('request', request => {
    if (request.url().includes('__inert_sentinel__')) requests.push(request.url());
  });
  await page.route('**/*__inert_sentinel__*', route => {
    routed.push(route.request().url());
    return route.abort();
  });
  // No CSP is installed: a lack of requests cannot be credited to a CSP denial.
  await page.route('**/inert-html-processing-probe', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto('/inert-html-processing-probe');
  const result = await page.evaluate(async () => {
    const helperPath = '/src/utils/editor-image-dom.ts';
    const safePath = '/src/utils/safe-html.ts';
    // Use Vite's exact optimized dependency URLs (including its version query),
    // so the probe and helpers share the same ProseMirror class/plugin instances.
    const editorModule = await (await fetch('/src/components/Editor.vue')).text();
    const dependencyUrl = (name: string) => {
      const url = editorModule.match(new RegExp(`"([^"\\n]*@tiptap_${name}\\.js[^"\\n]*)"`))?.[1];
      if (!url) throw new Error(`Missing Vite dependency URL: ${name}`);
      return url;
    };
    const corePath = dependencyUrl('core');
    const kitPath = dependencyUrl('starter-kit');
    const imagePath = dependencyUrl('extension-image');
    const { parseEditorHtml, serializeEditorHtml } = await import(/* @vite-ignore */ helperPath);
    const { sanitizeSafeHtml, isStandaloneSafeHtmlBlock } = await import(/* @vite-ignore */ safePath);
    const { Editor } = await import(/* @vite-ignore */ corePath);
    const { default: StarterKit } = await import(/* @vite-ignore */ kitPath);
    const { default: Image } = await import(/* @vite-ignore */ imagePath);
    const violations: string[] = [], activeAssignments: string[] = [];
    const violation = (event: SecurityPolicyViolationEvent) => { violations.push(event.blockedURI); };
    document.addEventListener('securitypolicyviolation', violation);
    const originalAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this.ownerDocument === document && /^(src|srcset|style)$/i.test(name) && value.includes('__inert_sentinel__')) {
        activeAssignments.push(`${this.tagName}.${name}=${value}`);
      }
      originalAttribute.call(this, name, value);
    };
    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...srcDescriptor,
      set(value: string) {
        if (this.ownerDocument === document && value.includes('__inert_sentinel__')) activeAssignments.push(`img.src=${value}`);
        srcDescriptor.set!.call(this, value);
      },
    });
    const originalParse = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = () => { throw new Error('Browser DOMParser reached'); };
    const host = document.createElement('div');
    document.body.appendChild(host);
    // This stub isolates helper conversion from the still-unmigrated real
    // Image NodeView. It renders no src; this is not whole-editor acceptance.
    const InertImage = Image.extend({
      addNodeView() { return () => ({ dom: document.createElement('img') }); },
    });
    const source = 'images/__inert_sentinel__-initial.png';
    const next = '/__inert_sentinel__-replacement.png';
    const raw = `<p>text</p><img src="${source}" alt="A &amp; B" title="Title" srcset="https://example.invalid/__inert_sentinel__-srcset 2x">`;
    let editor: InstanceType<typeof Editor> | undefined;
    try {
      editor = new Editor({
        element: host, extensions: [StarterKit, InertImage], content: raw,
        onBeforeCreate({ editor: current }: { editor: InstanceType<typeof Editor> }) {
          current.options.content = parseEditorHtml(current.options.content, current.schema).toJSON();
        },
      });
      const initial = editor.getJSON();
      const initialHtml = serializeEditorHtml(editor.state.doc);
      editor.commands.setContent(parseEditorHtml(`<img src="${next}" alt="next">`, editor.schema).toJSON());
      const updated = editor.getJSON();
      const updatedHtml = serializeEditorHtml(editor.state.doc);
      const hostile = '<style>@import "https://example.invalid/__inert_sentinel__-css";</style><iframe src="https://example.invalid/__inert_sentinel__-frame"></iframe><img src="https://example.invalid/__inert_sentinel__-remote" style="background:url(https://example.invalid/__inert_sentinel__-background)">';
      // These strings stay inert; neither sanitized output nor authored HTML
      // is installed into the browsing document.
      parseEditorHtml(hostile, editor.schema);
      const safe = sanitizeSafeHtml(hostile);
      const standalone = isStandaloneSafeHtmlBlock('<img src="file:///__inert_sentinel__-file.png">');
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { initial, initialHtml, updated, updatedHtml, safe, standalone, violations, activeAssignments, liveSrcs: Array.from(host.querySelectorAll('img')).map(img => img.getAttribute('src')) };
    } finally {
      editor?.destroy(); host.remove();
      Element.prototype.setAttribute = originalAttribute;
      Object.defineProperty(HTMLImageElement.prototype, 'src', srcDescriptor);
      DOMParser.prototype.parseFromString = originalParse;
      document.removeEventListener('securitypolicyviolation', violation);
    }
  });
  expect(result.initial.content).toContainEqual(expect.objectContaining({ type: 'image', attrs: expect.objectContaining({ src: 'images/__inert_sentinel__-initial.png', alt: 'A & B', title: 'Title' }) }));
  expect(result.initialHtml).toContain('src="images/__inert_sentinel__-initial.png"');
  expect(result.updated.content).toContainEqual(expect.objectContaining({ type: 'image', attrs: expect.objectContaining({ src: '/__inert_sentinel__-replacement.png', alt: 'next' }) }));
  expect(result.updatedHtml).toContain('src="/__inert_sentinel__-replacement.png"');
  expect(result.safe).not.toMatch(/<style|<iframe|background/);
  expect(result.safe).toContain('src="https://example.invalid/__inert_sentinel__-remote"');
  expect(result.standalone).toBe(true);
  expect(result.liveSrcs).toEqual([null]);
  expect(result.activeAssignments).toEqual([]);
  expect(result.violations).toEqual([]);
  expect(requests).toEqual([]);
  expect(routed).toEqual([]);
});
