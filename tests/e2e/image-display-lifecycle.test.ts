import { expect, test, type Page } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { openCodeView, startEditing, openVisualView } from './helpers/code-editor';

async function installImageRead(page: Page, delayed = false) {
  await page.evaluate(delay => {
    const state = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
      __imageDisplay: { created: string[]; revoked: string[]; paths: string[]; ambientReads: string[]; finish: (() => void)[] };
    };
    state.__imageDisplay = { created: [], revoked: [], paths: [], ambientReads: [], finish: [] };
    const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); state.__imageDisplay.created.push(url); return url; };
    URL.revokeObjectURL = url => { state.__imageDisplay.revoked.push(url); revoke(url); };
    const invoke = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === 'plugin:fs|read_file') state.__imageDisplay.ambientReads.push(command);
      if (command !== 'native_read_document_image') return invoke(command, args);
      const path = (args as { relativePath?: string } | undefined)?.relativePath;
      if (path) state.__imageDisplay.paths.push(path);
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      if (!delay) return Promise.resolve(Array.from(bytes));
      return new Promise(resolve => { state.__imageDisplay.finish.push(() => resolve(Array.from(bytes))); });
    };
  }, delayed);
}

test('local image display preserves the document source and releases its URL on editor unmount', async ({ page }) => {
  const path = '/test/image-display.md';
  await setupTauriMocks(page, {
    initialFs: { [path]: '# Image\n\n![local](images/import.png)\n\nTail\n' }, openFilePath: path,
  });
  await page.goto('/'); await installImageRead(page); await startEditing(page);
  const img = page.locator('.ProseMirror img.editor-image');
  await expect(img).toHaveAttribute('src', /^blob:/);
  const url = await img.getAttribute('src');
  const model = await page.locator('.ProseMirror').evaluate(element =>
    JSON.stringify((element as HTMLElement & { editor: { getJSON(): unknown } }).editor.getJSON()));
  expect(model).toContain('images/import.png'); expect(model).not.toContain('blob:');
  await openCodeView(page);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __imageDisplay: { revoked: string[] } }).__imageDisplay.revoked)).toContain(url);
});

test('relative images retain the literal path sent to the native document-image reader', async ({ page }) => {
  const path = '/root-image.md';
  await setupTauriMocks(page, {
    initialFs: { [path]: '# Root image\n\n![local](images/a.png)\n' }, openFilePath: path,
  });
  await page.goto('/'); await installImageRead(page); await startEditing(page);
  const img = page.locator('.ProseMirror img.editor-image');
  await expect(img).toHaveAttribute('src', /^blob:/);
  expect(await page.evaluate(() =>
    (window as unknown as { __imageDisplay: { paths: string[] } }).__imageDisplay.paths)).toEqual(['images/a.png']);
});

test('late image reads cannot create URLs after switching documents', async ({ page }) => {
  const first = '/test/first-image.md'; const second = '/test/second-image.md';
  const fs = await setupTauriMocks(page, {
    initialFs: { [first]: '# Image\n\n![local](images/import.png)\n', [second]: 'Second document\n' }, openFilePath: first,
  });
  await page.goto('/'); await installImageRead(page, true); await startEditing(page);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __imageDisplay: { finish: unknown[] } }).__imageDisplay.finish.length)).toBeGreaterThan(0);
  await fs.triggerOpenFiles([second]);
  await expect(page.locator('.tab.active')).toContainText('second-image.md'); await startEditing(page);
  await expect(page.locator('.ProseMirror')).toHaveText('Second document');
  await page.evaluate(async () => {
    const state = (window as unknown as { __imageDisplay: { finish: (() => void)[] } }).__imageDisplay;
    for (const finish of state.finish) finish();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  await expect(page.locator('.ProseMirror img')).toHaveCount(0);
  expect(await page.evaluate(() =>
    (window as unknown as { __imageDisplay: { created: string[] } }).__imageDisplay.created)).toEqual([]);
});


test('unselected absolute and remote sources stay unavailable without a filesystem fallback', async ({ page }) => {
  const path = '/test/denied-image.md';
  await setupTauriMocks(page, { initialFs: { [path]: '![absolute](/app-private/other.png)\n\n![remote](https://example.invalid/other.png)\n' }, openFilePath: path });
  await page.goto('/'); await installImageRead(page); await startEditing(page);
  const imgs = page.locator('.ProseMirror img.editor-image');
  await expect(imgs).toHaveCount(2);
  await expect(imgs.nth(0)).toHaveAttribute('data-image-status', 'unavailable');
  await expect(imgs.nth(1)).toHaveAttribute('data-image-status', 'unavailable');
  expect(await imgs.evaluateAll(images => images.map(img => img.getAttribute('src')))).toEqual([null, null]);
  expect(await page.evaluate(() => (window as unknown as { __imageDisplay: { paths: string[] } }).__imageDisplay.paths)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __imageDisplay: { ambientReads: string[] } }).__imageDisplay.ambientReads)).toEqual([]);
});

test('unsaved pasted bytes survive Code/Visual recreation with authored source and Undo', async ({ page }) => {
  await setupTauriMocks(page); await page.goto('/'); await installImageRead(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.locator('.nf-card:not(.nf-card--marp)').click();
  const root = page.locator('.ProseMirror');
  await expect(root).toHaveAttribute('contenteditable', 'true');
  await root.evaluate(element => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const file = new File([bytes], 'paste.png', { type: 'image/png' });
    const data = new DataTransfer(); data.items.add(file);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const img = page.locator('.ProseMirror img.editor-image');
  await expect(img).toHaveAttribute('src', /^blob:/);
  const originalUrl = await img.getAttribute('src');
  const source = await root.evaluate(element => {
    const ed = (element as HTMLElement & { editor: { getJSON(): { content?: { attrs?: { src?: string } }[] } } }).editor;
    return ed.getJSON().content?.find(node => node.attrs?.src)?.attrs?.src;
  });
  expect(source).toMatch(/^data:image\/png;base64,/); expect(source).not.toMatch(/^blob:/);
  await openCodeView(page);
  // The existing mode transition ignores repeat toggles during its 100 ms restore.
  await page.waitForTimeout(150);
  await openVisualView(page);
  await expect(img).toHaveAttribute('src', /^blob:/);
  expect(await img.getAttribute('src')).not.toBe(originalUrl);
  const model = await root.evaluate(element => JSON.stringify((element as HTMLElement & { editor: { getJSON(): unknown } }).editor.getJSON()));
  expect(model).toContain(source!); expect(model).not.toContain('blob:');
  expect(await page.evaluate(() => (window as unknown as { __imageDisplay: { paths: string[] } }).__imageDisplay.paths)).toEqual([]);
  // Deleting the node releases its display, while Undo still has the tab-owned bytes.
  await img.hover();
  await page.locator('.editor-image-toolbar-btn.danger').click();
  await expect(img).toHaveCount(0);
  await root.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(img).toHaveAttribute('src', /^blob:/);
});


test('deleting a previewed image removes preview consumers before revoking the display URL', async ({ page }) => {
  const path = '/test/preview-delete.md';
  await setupTauriMocks(page, { initialFs: { [path]: '![preview](images/a.png)\n' }, openFilePath: path });
  await page.goto('/'); await installImageRead(page); await startEditing(page);
  const img = page.locator('.ProseMirror img.editor-image');
  await expect(img).toHaveAttribute('src', /^blob:/);
  const url = await img.getAttribute('src');
  await img.click();
  await expect(page.locator('.image-preview-overlay img')).toHaveAttribute('src', url!);
  await page.evaluate(() => {
    const state = window as unknown as { __revokedWithConsumer: string[] };
    state.__revokedWithConsumer = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => {
      if (Array.from(document.querySelectorAll('img')).some(image => image.getAttribute('src') === url)) state.__revokedWithConsumer.push(url);
      revoke(url);
    };
    const editor = (document.querySelector('.ProseMirror') as HTMLElement & { editor: { commands: { setNodeSelection(pos: number): void; deleteSelection(): void } } }).editor;
    editor.commands.setNodeSelection(0); editor.commands.deleteSelection();
  });
  await expect(page.locator('.image-preview-overlay')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __imageDisplay: { revoked: string[] } }).__imageDisplay.revoked)).toContain(url);
  expect(await page.evaluate(() => (window as unknown as { __revokedWithConsumer: string[] }).__revokedWithConsumer)).toEqual([]);
});
