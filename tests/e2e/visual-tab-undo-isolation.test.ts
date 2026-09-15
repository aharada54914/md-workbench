import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { startEditing } from './helpers/code-editor';

test('Undo cannot apply a previous tab edit to a different file with identical content', async ({ page }) => {
  const first = '/test/undo-first.md';
  const second = '/test/undo-second.md';
  const fs = await setupTauriMocks(page, {
    initialFs: { [first]: 'Same', [second]: 'Same local' }, openFilePath: first,
  });
  await page.goto('/');
  await startEditing(page);
  const editor = page.locator('.ProseMirror');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.evaluate(element => (element as any).editor.commands.focus('end'));
  await expect(editor).toBeFocused();
  await page.keyboard.insertText(' local');
  await expect(editor).toHaveText('Same local');
  await fs.triggerOpenFiles([second]);
  await expect(page.locator('.tab.active')).toContainText('undo-second.md');
  await startEditing(page);
  await expect(editor).toHaveText('Same local');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveText('Same local');
  await page.keyboard.press('Control+s');
  expect(fs.getFs()[second]).toBe('Same local');
  expect(fs.getFs()[first]).toBe('Same');
});

test('Undo cannot apply a previous untitled tab edit to an identical new tab', async ({ page }) => {
  await setupTauriMocks(page);
  await page.goto('/');
  const newTab = async () => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.locator('.nf-card:not(.nf-card--marp)').click();
  };
  await newTab();
  const editor = page.locator('.ProseMirror');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  const initialTabCount = await page.locator('.tab-bar .tab').count();
  const original = await editor.innerHTML();
  await editor.evaluate(element => (element as any).editor.commands.focus('end'));
  await expect(editor).toBeFocused();
  await page.keyboard.insertText(' temporary');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveJSProperty('innerHTML', original);
  await newTab();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(initialTabCount + 1);
  await expect(editor).toHaveJSProperty('innerHTML', original);
  await editor.click();
  // The first tab's redo history is just as document-specific as Undo.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(editor).toHaveJSProperty('innerHTML', original);
});
