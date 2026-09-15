import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { codeEditor } from './helpers/code-editor';

test('unsupported source rejects Visual commands and offers exact Source editing', async ({ page }) => {
  const path = '/test/unsupported.md';
  const source = '\uFEFF# 日本語\r\n\r\n<!-- untouched -->\r\n\r\n[text][ref]  \r\n\r\n[ref]: https://example.com\r\n';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Edit source', exact: true })).toBeVisible();
  await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
  await page.locator('.ProseMirror').evaluate(element => {
    const editor = (element as HTMLElement & { editor: { commands: { insertContent: (text: string) => void } } }).editor;
    editor.commands.insertContent('MUST NOT BE SAVED');
  });
  await page.keyboard.press('Control+s');
  expect(fs.getFs()[path]).toBe(source);
  await page.getByRole('button', { name: 'Edit source', exact: true }).click();
  await expect(codeEditor(page)).toBeVisible();
  await codeEditor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('追記');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe(source + '追記');
});

test('safe Visual edit preserves the surrounding document bytes and Undo', async ({ page }) => {
  const path = '/test/safe.md';
  const source = '\uFEFF\r\n日本語の本文  \r\n\t';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('追記😀');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe(source.replace('本文', '本文追記😀'));
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe(source);
});


test('a delayed image paste cannot import into a subsequently selected document', async ({ page }) => {
  const first = '/test/first.md';
  const second = '/test/second.md';
  const fs = await setupTauriMocks(page, {
    initialFs: { [first]: 'First', [second]: 'Second' }, openFilePath: first,
  });
  await page.goto('/');
  await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
  await page.locator('.ProseMirror').evaluate(element => {
    const file = new File(['image'], 'paste.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(resolve => {
      (window as any).__finishDelayedPaste = () => resolve(new Uint8Array([1, 2, 3]).buffer);
    }) });
    const clipboard = new DataTransfer();
    clipboard.items.add(file);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishDelayedPaste)).toBe('function');
  await fs.triggerOpenFiles([second]);
  await expect(page.locator('.ProseMirror')).toHaveText('Second');
  await page.evaluate(async () => {
    (window as any).__finishDelayedPaste();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  await expect(page.locator('.ProseMirror img')).toHaveCount(0);
  expect(fs.getCalls().filter(call => call.cmd === 'write')).toEqual([]);
  expect(fs.getFs()).toEqual({ [first]: 'First', [second]: 'Second' });
});


test('a delayed image paste cannot cross identical untitled tabs', async ({ page }) => {
  const fs = await setupTauriMocks(page);
  await page.goto('/');
  const newTab = async () => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.locator('.nf-card:not(.nf-card--marp)').click();
  };
  await newTab();
  await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
  await expect(page.locator('.tab-bar .tab').nth(1)).toHaveClass(/active/);
  const initialHtml = await page.locator('.ProseMirror').innerHTML();
  await page.locator('.ProseMirror').evaluate(element => {
    const file = new File(['image'], 'paste.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(resolve => {
      (window as any).__finishUntitledPaste = () => resolve(new Uint8Array([1, 2, 3]).buffer);
    }) });
    const clipboard = new DataTransfer();
    clipboard.items.add(file);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishUntitledPaste)).toBe('function');
  await newTab();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(3);
  await expect(page.locator('.tab-bar .tab').nth(2)).toHaveClass(/active/);
  expect(await page.locator('.ProseMirror').innerHTML()).toBe(initialHtml);
  await page.evaluate(async () => {
    (window as any).__finishUntitledPaste();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  await expect(page.locator('.ProseMirror img')).toHaveCount(0);
  expect(await page.locator('.ProseMirror').innerHTML()).toBe(initialHtml);
  expect(fs.getCalls().filter(call => call.cmd === 'write')).toEqual([]);
});
