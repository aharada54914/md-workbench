import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { codeEditor, openCodeView } from './helpers/code-editor';

for (const mode of ['Source', 'Split']) {
  for (const selection of ['external', 'local', 'mixed'] as const) {
    test(`a ${selection} conflict merge in ${mode} keeps selected source bytes`, async ({ page }) => {
      const path = '/test/exact-merge.md';
      const source = '\uFEFFold first  \r\nanchor\r\nold last\t';
      const local = source + ' local';
      const external = '\uFEFFnew first\nanchor\r\nnew last  \r\n\r\n';
      const expected = selection === 'external' ? external : selection === 'local' ? local
        : '\uFEFFnew first\nanchor\r\nold last\t local';
      const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
      await page.goto('/');
      await expect(page.locator('.ProseMirror')).toContainText('old first');
      if (mode === 'Source') await openCodeView(page);
      else await page.locator('.split-editor-toggle-btn').first().click();
      await codeEditor(page).click();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(' local');
      await expect(page.locator('.tab.active .tab-unsaved')).toBeVisible();

      await fs.triggerExternalChange(path, external);
      const conflict = page.locator('.conflict-panel');
      await expect(conflict).toBeVisible();
      await conflict.locator('.mode-btn').last().click();
      await expect(conflict.locator('.merge-hunk--change')).toHaveCount(2);
      if (selection === 'external') {
        await conflict.locator('.merge-bulk-btn').first().click();
      } else if (selection === 'mixed') {
        await conflict.locator('.merge-hunk--change').first().locator('.hunk-btn--accept').click();
      }
      await conflict.locator('.conflict-actions .btn-primary').click();
      await expect(conflict).not.toBeVisible();
      await page.keyboard.press('Control+s');
      await expect.poll(() => fs.getFs()[path]).toBe(expected);
      await expect(conflict).not.toBeVisible();
      // A mode change must not reserialize the selected slices before another save.
      if (mode === 'Source') await page.getByRole('button', { name: 'Visual', exact: true }).click();
      else await page.locator('.split-editor-toggle-btn').first().click();
      await page.keyboard.press('Control+s');
      expect(fs.getFs()[path]).toBe(expected);
    });
  }
}
