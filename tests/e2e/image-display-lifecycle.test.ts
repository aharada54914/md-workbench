import { expect, test, type Page } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { openCodeView, startEditing } from './helpers/code-editor';

async function installImageRead(page: Page, delayed = false) {
  await page.evaluate(delay => {
    const state = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
      __imageDisplay: { created: string[]; revoked: string[]; paths: string[]; finish: (() => void)[] };
    };
    state.__imageDisplay = { created: [], revoked: [], paths: [], finish: [] };
    const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); state.__imageDisplay.created.push(url); return url; };
    URL.revokeObjectURL = url => { state.__imageDisplay.revoked.push(url); revoke(url); };
    const invoke = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command !== 'plugin:fs|read_file') return invoke(command, args);
      const path = (args as { path?: string } | undefined)?.path;
      if (path) state.__imageDisplay.paths.push(path);
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      if (!delay) return Promise.resolve(bytes);
      return new Promise(resolve => { state.__imageDisplay.finish.push(() => resolve(bytes)); });
    };
  }, delayed);
}

test('local image display preserves the document source and releases its URL on editor unmount', async ({ page }) => {
  const path = '/test/image-display.md';
  await setupTauriMocks(page, {
    initialFs: { [path]: '# Image\n\n![local](/app-private/import.png)\n\nTail\n' }, openFilePath: path,
  });
  await page.goto('/'); await installImageRead(page); await startEditing(page);
  const img = page.locator('.ProseMirror img.editor-image');
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect(img).toHaveAttribute('data-original-src', '/app-private/import.png');
  const url = await img.getAttribute('src');
  const model = await page.locator('.ProseMirror').evaluate(element =>
    (element as HTMLElement & { editor: { getHTML(): string } }).editor.getHTML());
  expect(model).toContain('/app-private/import.png'); expect(model).not.toContain('blob:');
  await openCodeView(page);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __imageDisplay: { revoked: string[] } }).__imageDisplay.revoked)).toContain(url);
});

test('relative images in a POSIX root document keep the absolute root when read', async ({ page }) => {
  const path = '/root-image.md';
  await setupTauriMocks(page, {
    initialFs: { [path]: '# Root image\n\n![local](images/a.png)\n' }, openFilePath: path,
  });
  await page.goto('/'); await installImageRead(page); await startEditing(page);
  const img = page.locator('.ProseMirror img.editor-image');
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect(img).toHaveAttribute('data-original-src', 'images/a.png');
  expect(await page.evaluate(() =>
    (window as unknown as { __imageDisplay: { paths: string[] } }).__imageDisplay.paths)).toEqual(['/images/a.png']);
});

test('late image reads cannot create URLs after switching documents', async ({ page }) => {
  const first = '/test/first-image.md'; const second = '/test/second-image.md';
  const fs = await setupTauriMocks(page, {
    initialFs: { [first]: '# Image\n\n![local](/app-private/import.png)\n', [second]: 'Second document\n' }, openFilePath: first,
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
