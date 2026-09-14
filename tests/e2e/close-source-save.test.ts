import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { codeEditor, openCodeView } from './helpers/code-editor';

for (const [name, newline, bom] of [['LF', '\n', ''], ['CRLF', '\r\n', ''], ['BOM-CRLF', '\r\n', '\uFEFF']]) {
  test('auto-save preserves ' + name + ' Source without a mounted visual editor', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mermark-settings', JSON.stringify({ autoSave: true, ai: { hasSeenFirstRun: true } }));
    });
    const path = '/test/auto.md';
    const source = bom + ['# 日本語', '', ':::unknown untouched', '', '$$a+b$$  ', '', ''].join(newline);
    const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
    await page.goto('/');
    await expect(page.locator('.ProseMirror')).toContainText('日本語');
    await openCodeView(page);
    await codeEditor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('追記😀');
    await expect.poll(() => fs.getFs()[path], { timeout: 15000 }).toBe(source + '追記😀');
    expect(fs.getCalls().filter(call => call.cmd === 'write').map(call => (call.args as { path: string }).path)).toEqual([path + '.tmp']);
  });

  test('window close saves ' + name + ' Source through the normal byte-preserving path', async ({ page }) => {
    const path = '/test/close.md';
    const source = bom + ['# 日本語', '', ':::unknown untouched', '', '$$a+b$$  ', '', ''].join(newline);
    const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
    await page.goto('/');
    await expect(page.locator('.ProseMirror')).toContainText('日本語');
    await openCodeView(page);
    await codeEditor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('追記😀');
    await fs.triggerWindowClose();
    await expect(page.getByRole('heading', { name: 'Unsaved Changes' })).toBeVisible();
    await page.locator('.dialog-actions .btn-save').click();
    await expect.poll(() => fs.getFs()[path]).toBe(source + '追記😀');
    await expect.poll(() => page.evaluate(() => (window as any).__mockWindowCommands)).toEqual(['plugin:window|destroy']);
    expect(fs.getCalls().filter(call => call.cmd === 'write').map(call => (call.args as { path: string }).path)).toEqual([path + '.tmp']);
  });
}
