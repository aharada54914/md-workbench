import { expect, test } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { fillCodeEditor, openCodeView, openVisualView, startEditing } from './helpers/code-editor';

test('actual Editor keeps authored image HTML inert through parsing, serialization, paste and source reset', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('__editor_raw_')) requests.push(request.url()); });
  await page.route('**/*__editor_raw_*', route => route.abort());
  await setupTauriMocks(page, { initialFs: { '/test/inert.md': '$x$\n\n![raw](images/__editor_raw_initial.png)\n\n![file](file:///__editor_raw_file.png)\n\n<p><img src="https://example.invalid/__editor_raw_html.png" alt="HTML"></p>\n' }, openFilePath: '/test/inert.md' });
  await page.addInitScript(() => {
    const records = { assignments: [] as string[], adoptions: [] as string[], csp: [] as string[] };
    (window as unknown as { __inertEditor: typeof records }).__inertEditor = records;
    const raw = (value: string) => value.includes('__editor_raw_');
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (this.ownerDocument === document && /^(src|srcset|style)$/.test(name) && raw(value)) records.assignments.push(value);
      return setAttribute.call(this, name, value);
    };
    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', { ...src, set(value: string) {
      if (this.ownerDocument === document && raw(value)) records.assignments.push(value);
      src.set!.call(this, value);
    } });
    const appendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function<T extends Node>(node: T): T {
      if (this.ownerDocument === document) {
        const images = node instanceof Element ? [node, ...node.querySelectorAll('img')] : node instanceof DocumentFragment ? [...node.querySelectorAll('img')] : [];
        for (const img of images) if (img.tagName === 'IMG' && raw(img.getAttribute('src') ?? '')) records.adoptions.push(img.getAttribute('src')!);
      }
      return appendChild.call(this, node) as T;
    };
    document.addEventListener('securitypolicyviolation', event => { if (raw(event.blockedURI)) records.csp.push(event.blockedURI); });
  });
  await page.goto('/');
  await expect(page.locator('.tab.active')).toContainText('inert.md');
  await startEditing(page);
  const root = page.locator('.ProseMirror');
  await expect(root.locator('img.editor-image, .safe-html-block img')).toHaveCount(3);
  await expect(root.locator('img.editor-image, .safe-html-block img').first()).toHaveAttribute('data-image-status', 'unavailable');
  expect(await root.locator('img.editor-image, .safe-html-block img').evaluateAll(images => images.map(img => img.getAttribute('src')))).toEqual([null, null, null]);
  const serialized = await root.evaluate(async element => {
    const { serializeEditorHtml } = await import('/src/utils/editor-image-dom.ts');
    const { htmlToMarkdown } = await import('/src/utils/markdown-converter.ts');
    const editor = (element as HTMLElement & { editor: { state: { doc: Parameters<typeof serializeEditorHtml>[0] } } }).editor;
    const html = serializeEditorHtml(editor.state.doc);
    return { html, markdown: htmlToMarkdown(html) };
  });
  expect(serialized.html).toContain('images/__editor_raw_initial.png');
  expect(serialized.markdown).toContain('images/__editor_raw_initial.png');
  expect(serialized.markdown).toContain('$x$');
  await root.evaluate(element => {
    const editor = (element as HTMLElement & { editor: { commands: { selectAll(): void } } }).editor;
    editor.commands.selectAll();
    const data = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    if (!data.getData('text/html').includes('images/__editor_raw_initial.png')) throw new Error('authored clipboard source lost');
    const table = new DataTransfer(); table.setData('text/html', '<table><tr><td>&lt;img src="images/__editor_raw_literal.png"&gt;</td></tr></table>');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: table, bubbles: true, cancelable: true }));
  });
  await expect(root.locator('table')).toContainText('<img src="images/__editor_raw_literal.png">');
  await expect(root.locator('img.editor-image, .safe-html-block img')).toHaveCount(0);
  await openCodeView(page);
  await fillCodeEditor(page, '$y$\n\n![reset](images/__editor_raw_reset.png)\n');
  // Allow the existing 100 ms mode-transition guard to finish.
  await page.waitForTimeout(150);
  await openVisualView(page);
  await expect(root.locator('img.editor-image, .safe-html-block img')).toHaveCount(1);
  await expect(root.locator('img.editor-image, .safe-html-block img')).not.toHaveAttribute('src');
  await page.keyboard.press('Control+s');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const observed = await page.evaluate(() => (window as unknown as { __inertEditor: { assignments: string[]; adoptions: string[]; csp: string[] } }).__inertEditor);
  expect(observed).toEqual({ assignments: [], adoptions: [], csp: [] });
  expect(requests).toEqual([]);
  // Positive control proves the observers see an actual active raw-source request.
  await page.evaluate(() => { const image = document.createElement('img'); image.src = '/__editor_raw_positive.png'; document.body.appendChild(image); });
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { __inertEditor: { assignments: string[] } }).__inertEditor.assignments)).toContain('/__editor_raw_positive.png');
});
