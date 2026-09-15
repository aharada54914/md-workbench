import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { codeEditor, openCodeView } from './helpers/code-editor';

test('cross-pane close selection and Cancel preserve the live Source document', async ({ page }) => {
  const leftPath = '/test/left.md', rightPath = '/test/right.md';
  const source = '\uFEFF# Right\r\n\r\n:::unknown  \r\n';
  const fs = await setupTauriMocks(page, { initialFs: { [leftPath]: '# Left\n', [rightPath]: source }, openFilePath: leftPath });
  await page.goto('/');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Left');
  // Both panes explicitly enter Source before the close flow selects the left tab.
  await openCodeView(page);
  await page.evaluate(async ({ path, source }) => {
    const splitPath = '/src/composables/useSplitView.ts';
    const markdownPath = '/src/utils/markdown-converter.ts';
    const { useSplitView } = await import(/* @vite-ignore */ splitPath);
    const { markdownToHtml } = await import(/* @vite-ignore */ markdownPath);
    const split = useSplitView();
    split.splitState.value.panes[0].tabs[0].hasChanges = true;
    split.enableSplit();
    const id = split.createTab('right', path, markdownToHtml(source), 'right.md');
    split.splitState.value.panes[1].tabs.find((tab: { id: string }) => tab.id === id).originalMarkdown = source;
    split.setActivePane('right');
  }, { path: rightPath, source });
  await openCodeView(page);
  await codeEditor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('追記😀');
  await fs.triggerWindowClose();
  await expect(page.getByRole('heading', { name: 'Unsaved Changes' })).toBeVisible();
  await page.locator('.dialog-actions .btn-cancel').click();
  // Switching the other pane to Visual must not make the parked right-hand
  // Source tab fall back to its stale pre-edit HTML on reactivation.
  await page.getByRole('button', { name: 'Visual', exact: true }).click();
  await page.evaluate(async () => {
    const modulePath = '/src/composables/useSplitView.ts';
    const { useSplitView } = await import(/* @vite-ignore */ modulePath);
    useSplitView().setActivePane('right');
  });
  await expect(codeEditor(page)).toContainText('追記😀');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[rightPath]).toBe(source + '追記😀');
  await page.getByRole('button', { name: 'Visual', exact: true }).click();
  await expect(page.locator('.editor-pane.active .ProseMirror')).toContainText('追記😀');
  expect(fs.getFs()[leftPath]).toBe('# Left\n');
  expect(await page.evaluate(() => (window as any).__mockWindowCommands)).toEqual([]);
});

for (const [name, newline, bom] of [['LF', '\n', ''], ['CRLF', '\r\n', ''], ['BOM-CRLF', '\r\n', '\uFEFF']]) {
  test('auto-save preserves ' + name + ' Source without a mounted visual editor', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mermark-settings', JSON.stringify({ autoSave: true, ai: { hasSeenFirstRun: true } }));
    });
    const path = '/test/auto.md';
    const source = bom + ['# 日本語', '', ':::unknown untouched', '', '$$a+b$$  ', '', ''].join(newline);
    const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
    await page.goto('/');
    await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('日本語');
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
    await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('日本語');
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
