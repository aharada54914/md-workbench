import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { fillCodeEditor, getCodeEditorValue, openCodeView } from './helpers/code-editor';

const path = '/test/conflict-order.md';

for (const first of ['save', 'watch'] as const) {
  test(`${first} conflict retains its merge selection while the other request waits`, async ({ page }) => {
    let releaseWatch!: () => void;
    const watchGate = new Promise<void>(resolve => { releaseWatch = resolve; });
    const mock = await setupTauriMocks(page, {
      initialFs: { [path]: 'original' }, openFilePath: path,
      beforeWatchRead: () => watchGate,
    });
    try {
      await page.goto('/');
      await expect(page.locator('.tab.active')).toContainText('conflict-order.md');
      await openCodeView(page);
      await fillCodeEditor(page, 'local edit');
      await expect(page.locator('.tab.active .tab-unsaved')).toBeVisible();
      await mock.triggerExternalChange(path, 'external edit');
      if (first === 'watch') releaseWatch();
      else await page.keyboard.press('Control+s');
      const panel = page.locator('.conflict-panel');
      await expect(panel).toHaveCount(1);
      await expect(panel.locator('.btn-secondary')).toHaveText(first === 'save' ? 'Save Anyway' : 'Keep My Changes');
      await panel.locator('.mode-btn').last().click();
      await panel.locator('.merge-bulk-btn').first().click();
      await expect(panel.locator('.hunk-btn--accept.active')).toHaveCount(1);

      const operation = first === 'save' ? 'watch_read' : 'read';
      const reads = () => mock.getCalls().filter(call => call.cmd === operation && call.args === path).length;
      const before = reads();
      if (first === 'save') releaseWatch();
      else await page.keyboard.press('Control+s');
      await expect.poll(reads).toBeGreaterThan(before);
      // The IPC completion and reactive display have both had a render turn.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(panel).toHaveCount(1);
      await expect(panel.locator('.hunk-btn--accept.active')).toHaveCount(1);
      await expect.poll(() => getCodeEditorValue(page)).toBe('local edit');

      if (first === 'save') {
        // Escape only cancels the displayed Save request. The queued watcher
        // remains actionable, without inheriting the first merge selections.
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(1);
        await expect(panel.locator('.btn-secondary')).toHaveText('Keep My Changes');
        await expect(panel.locator('.merge-view')).toHaveCount(0);
        await panel.locator('.btn-primary').click();
      } else {
        // Accept disk in the first request; the waiting Save snapshot becomes
        // obsolete and its later Save Anyway answer must not overwrite disk.
        await panel.locator('.mode-btn').first().click();
        await panel.locator('.btn-primary').click();
        await expect(panel).toHaveCount(1);
        await expect(panel.locator('.btn-secondary')).toHaveText('Save Anyway');
        await panel.locator('.btn-secondary').click();
      }
      await expect(panel).toHaveCount(0);
      await expect.poll(() => getCodeEditorValue(page)).toBe('external edit');
      expect(mock.getFs()[path]).toBe('external edit');
      expect(mock.getCalls().filter(call => call.cmd === 'write')).toHaveLength(0);
    } finally {
      releaseWatch();
    }
  });
}
