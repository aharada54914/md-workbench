import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';

test('a saved Visual edit cannot overwrite a later external reload with stale source', async ({ page }) => {
  const path = '/test/visual-reload.md';
  const source = '\uFEFF\r\nOriginal  \r\n\t';
  const external = '\uFEFF\r\nExternal replacement  \r\n\t';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' edited');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe(source.replace('Original', 'Original edited'));

  await fs.triggerExternalChange(path, external);
  await expect(editor).toContainText('External replacement');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  // Cross the existing delayed hydration dirty event before the next save.
  await page.waitForTimeout(350);
  await page.keyboard.press('Control+s');
  await expect(page.locator('.conflict-panel')).not.toBeVisible();
  expect(fs.getFs()[path]).toBe(external);

  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' continued');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe(external.replace('replacement', 'replacement continued'));
});

test('a watcher conflict merge stays dirty and can be saved against the actual disk version', async ({ page }) => {
  const path = '/test/visual-merge.md';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: 'Original' }, openFilePath: path });
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' local');
  await fs.triggerExternalChange(path, 'External');
  const conflict = page.locator('.conflict-panel');
  await expect(conflict).toBeVisible();
  await conflict.locator('.mode-btn').last().click();
  // No external hunk selected: retain the canonical local source.
  await conflict.locator('.conflict-actions .btn-primary').click();
  await expect(conflict).not.toBeVisible();
  await expect(editor).toContainText('Original local');
  expect(fs.getFs()[path]).toBe('External');
  await expect(page.locator('.tab.active .tab-unsaved')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe('Original local');
  await expect(conflict).not.toBeVisible();
});
