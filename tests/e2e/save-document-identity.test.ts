import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';

const a = '/test/a.md';
const b = '/test/b.md';
const copy = '/test/captured-copy.md';
const source = '\uFEFF# Original A\r\n\r\n  exact\t';
const preview = (page: Page) => page.frameLocator('iframe[title="Isolated document preview"]').locator('body');
const watchedPaths = (page: Page) => page.evaluate(() =>
  Object.values((window as any).__nativeWatchSubscriptions).map((watch: any) => watch.path).sort());

async function beginSaveAs(page: Page) {
  await page.evaluate(() => { (window as any).__mockDeferSaveDialog = true; });
  await page.keyboard.press('Control+Shift+s');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__resolveSaveDialog)).toBe('function');
}
async function resolveSaveAs(page: Page, path: string | null) {
  await page.evaluate(path => {
    (window as any).__mockDeferSaveDialog = false;
    (window as any).__resolveSaveDialog(path);
  }, path);
}
async function setup(page: Page) {
  const fs = await setupTauriMocks(page, {
    initialFs: { [a]: source, [b]: '# Other B\n' }, openFilePaths: [a, b],
  });
  await page.goto('/');
  await expect(preview(page)).toContainText('Other B');
  await page.locator('.tab-bar .tab', { hasText: 'a.md' }).click();
  await expect(preview(page)).toContainText('Original A');
  await expect.poll(() => watchedPaths(page)).toEqual([a, b]);
  return fs;
}

test('Save As keeps the captured document when another tab becomes active and requires explicit READ for its new watch', async ({ page }) => {
  const fs = await setup(page);
  await beginSaveAs(page);
  await page.locator('.tab-bar .tab', { hasText: 'b.md' }).click();
  await expect(preview(page)).toContainText('Other B');
  await resolveSaveAs(page, copy);
  await expect.poll(() => fs.getFs()[copy]).toBe(source);
  await expect(page.locator('.tab-bar .tab.active')).toContainText('b.md');
  await expect(preview(page)).toContainText('Other B');
  await expect(page.locator('.tab-bar .tab', { hasText: 'captured-copy.md' })).toBeVisible();
  await expect.poll(() => watchedPaths(page)).toEqual([b]);
  // Save authority cannot install READ. The inactive saved document retains a
  // warning, then explicit native same-path selection resumes its own watch.
  await page.locator('.tab-bar .tab', { hasText: 'captured-copy.md' }).click();
  await expect(preview(page)).toContainText('Original A');
  await expect(page.getByTestId('monitoring-warning')).toContainText('Saved, but');
  await page.evaluate(copy => { (window as any).__mockDocumentSelection = [copy]; }, copy);
  await page.getByTestId('monitoring-warning').getByRole('button').click();
  await expect.poll(() => watchedPaths(page)).toEqual([b, copy]);
  await expect(page.getByTestId('monitoring-warning')).not.toBeVisible();
  expect(fs.getFs()[a]).toBe(source);
  expect(fs.getFs()[b]).toBe('# Other B\n');
});

test('cancelled Save As keeps the original path and watcher after a tab switch', async ({ page }) => {
  const fs = await setup(page);
  await beginSaveAs(page);
  await page.locator('.tab-bar .tab', { hasText: 'b.md' }).click();
  await resolveSaveAs(page, null);
  await expect(preview(page)).toContainText('Other B');
  await expect.poll(() => watchedPaths(page)).toEqual([a, b]);
  expect(fs.getCalls().filter(call => call.cmd === 'write')).toEqual([]);
  await expect(page.locator('.tab-bar .tab', { hasText: 'a.md' })).toBeVisible();
});

test('closing the captured tab during Save As prevents late writes and watcher resurrection', async ({ page }) => {
  const fs = await setup(page);
  await beginSaveAs(page);
  await page.locator('.tab-bar .tab.active .tab-close').click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
  await resolveSaveAs(page, copy);
  await expect(preview(page)).toContainText('Other B');
  await expect.poll(() => watchedPaths(page)).toEqual([b]);
  expect(fs.getCalls().filter(call => call.cmd === 'write')).toEqual([]);
  expect(fs.getFs()[copy]).toBeUndefined();
  await expect(page.locator('.tab-bar .tab')).not.toContainText('captured-copy.md');
});
