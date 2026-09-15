import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { fillCodeEditor, getCodeEditorValue, openCodeView } from './helpers/code-editor';

const a = '/test/a.md';
const b = '/test/b.md';
const source = '# Shared original\n';
const watchedPaths = (page: Page) => page.evaluate(() => {
  const state = window as unknown as { __nativeWatchSubscriptions: Record<string, { path: string }> };
  return Object.values(state.__nativeWatchSubscriptions).map(item => item.path).sort();
});

test('closing one same-path tab retains the remaining tab watcher until its final owner closes', async ({ page }) => {
  const mock = await setupTauriMocks(page, {
    initialFs: { [a]: source, [b]: source }, openFilePaths: [a, b],
  });
  await page.goto('/');
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
  await page.locator('.tab-bar .tab', { hasText: 'a.md' }).click();
  await page.evaluate(path => {
    (window as unknown as { __mockDialogSavePath: string }).__mockDialogSavePath = path;
  }, b);
  await page.keyboard.press('Control+Shift+s');
  await expect(page.locator('.tab-bar .tab', { hasText: 'b.md' })).toHaveCount(2);
  await expect.poll(() => watchedPaths(page)).toEqual([b]);

  await page.locator('.tab-bar .tab.active .tab-close').click();
  await expect(page.locator('.tab-bar .tab', { hasText: 'b.md' })).toHaveCount(1);
  await expect.poll(() => watchedPaths(page)).toEqual([b]);
  await mock.triggerExternalChange(b, '# Still watching\n');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body'))
    .toContainText('Still watching');

  await page.locator('.tab-bar .tab.active .tab-close').click();
  await expect.poll(() => watchedPaths(page)).toEqual([]);
});


for (const operation of ['clean reload', 'dirty reload', 'save conflict'] as const) {
  const dirty = operation !== 'clean reload';
  test(`${operation} targets the active duplicate and its conflict choice`, async ({ page }) => {
    await setupTauriMocks(page, { initialFs: { [a]: source, [b]: source }, openFilePaths: [a, b] });
    await page.goto('/');
    await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
    await page.locator('.tab-bar .tab', { hasText: 'a.md' }).click();
    await page.evaluate(path => {
      (window as unknown as { __mockDialogSavePath: string }).__mockDialogSavePath = path;
    }, b);
    await page.keyboard.press('Control+Shift+s');
    await expect(page.locator('.tab-bar .tab', { hasText: 'b.md' })).toHaveCount(2);
    await page.locator('.tab-bar .tab').last().click();
    await openCodeView(page);
    if (dirty) {
      await fillCodeEditor(page, '# Local duplicate edit\n');
      await expect(page.locator('.tab.active .tab-unsaved')).toBeVisible();
    }
    // Set disk bytes without a watcher event so only manual reload chooses a tab.
    await page.evaluate(async path => {
      const host = window as unknown as { __mockFsWrite: (path: string, content: string) => Promise<void> };
      await host.__mockFsWrite(path, '# Manual external\n');
    }, b);
    await page.keyboard.press(operation === 'save conflict' ? 'Control+s' : 'Control+r');
    if (dirty) {
      const conflict = page.locator('.conflict-panel');
      await expect(conflict).toBeVisible();
      await conflict.locator('button').filter({ hasText: /load external/i }).click();
      await expect(conflict).not.toBeVisible();
    }
    await expect.poll(() => getCodeEditorValue(page)).toContain('Manual external');
    await page.locator('.tab-bar .tab').first().click();
    await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body'))
      .toContainText('Shared original');
  });
}
