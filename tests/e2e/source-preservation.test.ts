import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';

for (const [name, newline, bom] of [['LF', '\n', ''], ['CRLF', '\r\n', ''], ['BOM-CRLF', '\r\n', '\uFEFF']]) {
  test(`unchanged ${name} Save As keeps source, unknown syntax and trailing spaces`, async ({ page }) => {
    const path = '/test/original.md', copy = '/test/copied.md';
    const source = bom + ['# 日本語', '', ':::unknown untouched', '', '$$a+b$$  ', '', '\t', ''].join(newline);
    const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
    await page.goto('/');
    await expect(page.locator('.ProseMirror')).toContainText('日本語');
    await page.evaluate(path => { (window as Record<string, unknown>).__mockDialogSavePath = path; }, copy);
    await page.keyboard.press('Control+Shift+s');
    await expect.poll(() => fs.getFs()[copy]).toBe(source);
    expect(fs.getFs()[path]).toBe(source);
  });
}
