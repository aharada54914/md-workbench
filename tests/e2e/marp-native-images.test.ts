import { expect, test, type Page } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { startEditing } from './helpers/code-editor';

async function observeImageReads(page: Page) {
  await page.evaluate(() => {
    type State = { reads: { path: string; id: string; relative: string }[]; ambient: string[]; delay: boolean; finish: (() => void)[] };
    const host = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }; __marpImages: State };
    const state = host.__marpImages = { reads: [], ambient: [], delay: false, finish: [] } as State;
    const invoke = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'plugin:fs|read_file') state.ambient.push(String(args?.path));
      if (cmd !== 'native_read_document_image') return invoke(cmd, args);
      const path = String(args?.documentPath); const id = String(args?.expectedDocumentGrantId);
      const relative = String(args?.relativePath);
      const current = await invoke('native_resolve_image_document', { documentPath: path }) as { grantId: string };
      if (current.grantId !== id || relative !== 'images/a.png') throw { code: 'permission_required' };
      state.reads.push({ path, id, relative });
      const bytes = Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHc8AAAAASUVORK5CYII='), c => c.charCodeAt(0));
      if (!state.delay) return bytes;
      return new Promise(resolve => state.finish.push(() => resolve(bytes)));
    };
  });
}
const deck = (heading: string) => `---\nmarp: true\n---\n\n# ${heading}\n\n![local](images/a.png)\n`;

test('actual App live and presentation use current native image authority without ambient reads', async ({ page }) => {
  const path = '/test/native-marp.md';
  await setupTauriMocks(page, { initialFs: { [path]: deck('Native deck') }, openFilePath: path });
  await page.goto('/'); await observeImageReads(page); await startEditing(page);
  await expect(page.locator('.ProseMirror img.editor-image')).toHaveAttribute('src', /^blob:/);
  await page.locator('.marp-bar').getByRole('button', { name: '👁 Live preview', exact: true }).click();
  const live = page.frameLocator('.marp-live-frame');
  await expect(live.getByRole('heading', { name: 'Native deck' })).toBeVisible();
  await expect(live.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect.poll(() => live.locator('img').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
  await page.locator('.marp-bar-btn--primary').click();
  const present = page.frameLocator('.marp-frame');
  await expect(present.getByRole('heading', { name: 'Native deck' })).toBeVisible();
  await expect(present.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  const state = await page.evaluate(() => (window as unknown as { __marpImages: { reads: { path: string; id: string; relative: string }[]; ambient: string[] } }).__marpImages);
  expect(state.reads.length).toBeGreaterThanOrEqual(3); // Editor, live and presentation are separate consumers.
  expect(state.reads.every(read => read.path === path && read.relative === 'images/a.png' && !!read.id)).toBe(true);
  expect(state.ambient).toEqual([]);
});

test('closing a presentation and switching documents discards its delayed image result', async ({ page }) => {
  const first = '/test/old-marp.md'; const second = '/test/new-marp.md';
  const fs = await setupTauriMocks(page, { initialFs: { [first]: deck('Old deck'), [second]: deck('New deck') }, openFilePath: first });
  await page.goto('/'); await observeImageReads(page); await startEditing(page);
  await expect(page.locator('.ProseMirror img.editor-image')).toHaveAttribute('src', /^blob:/);
  await page.evaluate(() => { (window as unknown as { __marpImages: { delay: boolean } }).__marpImages.delay = true; });
  await page.locator('.marp-bar-btn--primary').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __marpImages: { finish: unknown[] } }).__marpImages.finish.length)).toBe(1);
  await page.locator('.marp-close').click();
  await page.evaluate(() => { (window as unknown as { __marpImages: { delay: boolean } }).__marpImages.delay = false; });
  await fs.triggerOpenFiles([second]); await expect(page.locator('.tab.active')).toContainText('new-marp.md'); await startEditing(page);
  await page.locator('.marp-bar-btn--primary').click();
  const frame = page.frameLocator('.marp-frame');
  await expect(frame.getByRole('heading', { name: 'New deck' })).toBeVisible();
  await page.evaluate(() => {
    const state = (window as unknown as { __marpImages: { finish: (() => void)[] } }).__marpImages;
    state.finish.splice(0).forEach(finish => finish());
  });
  await expect(frame.getByRole('heading', { name: 'New deck' })).toBeVisible();
  await expect(frame.getByRole('heading', { name: 'Old deck' })).toHaveCount(0);
  await expect(frame.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
});
