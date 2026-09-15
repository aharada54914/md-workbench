import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { fillCodeEditor, getCodeEditorValue, openCodeView } from './helpers/code-editor';

const pathA = '/test/queue-a.md';
const pathB = '/test/queue-b.md';

async function selectTab(page: Page, name: string) {
  await page.locator('.tab-bar .tab').filter({ hasText: name }).click();
  await expect(page.locator('.tab.active')).toContainText(name);
}

async function dirtyDocuments(page: Page) {
  const fs = await setupTauriMocks(page, {
    initialFs: { [pathA]: 'original A', [pathB]: 'original B' },
    openFilePaths: [pathA, pathB],
  });
  await page.goto('/');
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
  for (const [name, source, local] of [
    ['queue-a.md', 'original A', 'local A'], ['queue-b.md', 'original B', 'local B'],
  ]) {
    await selectTab(page, name);
    await openCodeView(page);
    await expect.poll(() => getCodeEditorValue(page)).toBe(source);
    await fillCodeEditor(page, local);
    await expect(page.locator('.tab.active .tab-unsaved')).toBeVisible();
  }
  return fs;
}

// The mock forwards the real watch Channel callback. Wait for its read and a
// browser render turn while the displayed dialog deliberately remains stable.
async function observeExternal(page: Page, fs: Awaited<ReturnType<typeof setupTauriMocks>>, path: string, content: string) {
  const reads = () => fs.getCalls().filter(call => call.cmd === 'read' && call.args === path).length;
  const previous = reads();
  await fs.triggerExternalChange(path, content);
  await expect.poll(reads).toBeGreaterThan(previous);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('watcher conflicts stay FIFO and reset merge selections for the next document', async ({ page }) => {
  const fs = await dirtyDocuments(page);
  const conflict = page.locator('.conflict-panel');
  await observeExternal(page, fs, pathA, 'external A');
  await expect(conflict.locator('.conflict-filename')).toHaveText('queue-a.md');
  await conflict.locator('.mode-btn').last().click();
  await conflict.locator('.merge-bulk-btn').first().click();
  await expect(conflict.locator('.hunk-btn--accept.active')).toHaveCount(1);

  await observeExternal(page, fs, pathB, 'external B');
  await expect(conflict.locator('.conflict-filename')).toHaveText('queue-a.md');
  await expect(conflict.locator('.hunk-btn--accept.active')).toHaveCount(1);
  await conflict.locator('.conflict-actions .btn-primary').click();

  await expect(conflict.locator('.conflict-filename')).toHaveText('queue-b.md');
  await expect(conflict.locator('.mode-btn').first()).toHaveClass(/active/);
  await expect(conflict.locator('.merge-view')).toHaveCount(0);
  await conflict.locator('.mode-btn').last().click();
  await expect(conflict.locator('.hunk-btn--accept.active')).toHaveCount(0);
  await expect(conflict.locator('.hunk-btn--reject.active')).toHaveCount(1);
  await conflict.locator('.conflict-actions .btn-primary').click();
  await expect(conflict).not.toBeVisible();
  await expect.poll(() => getCodeEditorValue(page)).toBe('local B');
  await expect(page.locator('.tab.active .tab-unsaved')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[pathB]).toBe('local B');
  await selectTab(page, 'queue-a.md');
  await expect.poll(() => getCodeEditorValue(page)).toBe('external A');
  await expect(page.locator('.tab.active .tab-unsaved')).not.toBeVisible();
  expect(fs.getFs()[pathA]).toBe('external A');
});

for (const action of ['load', 'merge'] as const) {
  test(`an obsolete watcher ${action} answer preserves the buffer and advances to the latest candidate`, async ({ page }) => {
    const fs = await dirtyDocuments(page);
    await selectTab(page, 'queue-a.md');
    const conflict = page.locator('.conflict-panel');
    await observeExternal(page, fs, pathA, 'obsolete external A');
    await expect(conflict).toContainText('obsolete external A');
    if (action === 'merge') {
      await conflict.locator('.mode-btn').last().click();
      await conflict.locator('.merge-bulk-btn').first().click();
    }
    await observeExternal(page, fs, pathA, 'latest external A');
    await expect(conflict).toContainText('obsolete external A');
    await expect(conflict).not.toContainText('latest external A');
    await conflict.locator('.conflict-actions .btn-primary').click();

    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText('latest external A');
    await expect(conflict).not.toContainText('obsolete external A');
    await expect.poll(() => getCodeEditorValue(page)).toBe('local A');
    await expect(page.locator('.tab.active .tab-unsaved')).toBeVisible();
    await conflict.locator('.conflict-actions .btn-primary').click();
    await expect(conflict).not.toBeVisible();
    await expect.poll(() => getCodeEditorValue(page)).toBe('latest external A');
    await expect(page.locator('.tab.active .tab-unsaved')).not.toBeVisible();
    expect(fs.getCalls().filter(call => call.cmd === 'write')).toHaveLength(0);
    await selectTab(page, 'queue-b.md');
    await expect.poll(() => getCodeEditorValue(page)).toBe('local B');
    await expect(page.locator('.tab.active .tab-unsaved')).toBeVisible();
  });
}
