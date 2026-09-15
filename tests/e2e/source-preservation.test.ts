import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { codeEditor, fillCodeEditor, openCodeView } from './helpers/code-editor';

for (const [name, newline, bom] of [['LF', '\n', ''], ['CRLF', '\r\n', ''], ['BOM-CRLF', '\r\n', '\uFEFF']]) {
  test(`unchanged ${name} Save As keeps source, unknown syntax and trailing spaces`, async ({ page }) => {
    const path = '/test/original.md', copy = '/test/copied.md';
    const source = bom + ['# 日本語', '', ':::unknown untouched', '', '$$a+b$$  ', '', '\t', ''].join(newline);
    const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
    await page.goto('/');
    await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('日本語');
    await page.evaluate(path => { (window as Record<string, unknown>).__mockDialogSavePath = path; }, copy);
    await page.keyboard.press('Control+Shift+s');
    await expect.poll(() => fs.getFs()[copy]).toBe(source);
    expect(fs.getFs()[path]).toBe(source);
    await openCodeView(page);
    await codeEditor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('追記😀');
    await page.keyboard.press('Control+s');
    await expect.poll(() => fs.getFs()[copy]).toBe(source + '追記😀');
    expect(fs.getFs()[path]).toBe(source);
  });
}

for (const [name, newline, bom] of [['LF', '\n', ''], ['CRLF', '\r\n', ''], ['BOM-CRLF', '\r\n', '\uFEFF']]) {
  test(`edited ${name} source survives Visual and Split transitions before saving`, async ({ page }) => {
    const path = '/test/transitions.md';
    const source = bom + ['# 原文', '', ':::unknown untouched  ', '', '\t', ''].join(newline);
    const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
    await page.goto('/');
    await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('原文');
    await openCodeView(page);
    await codeEditor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('追記😀');
    await page.getByRole('button', { name: 'Visual', exact: true }).click();
    await expect(page.locator('.ProseMirror')).toContainText('追記😀');
    await page.locator('.split-editor-toggle-btn').first().click();
    await expect(codeEditor(page)).toContainText('追記😀');
    await page.locator('.split-editor-toggle-btn').first().click();
    await expect(page.locator('.ProseMirror')).toContainText('追記😀');
    await page.keyboard.press('Control+s');
    await expect.poll(() => fs.getFs()[path]).toBe(source + '追記😀');
    await openCodeView(page);
    await page.keyboard.press('Control+s');
    expect(fs.getFs()[path]).toBe(source + '追記😀');
  });
}

test('Split tab switches and exit keep unedited source clean and exact', async ({ page }) => {
  const path = '/test/clean.md';
  const source = '\uFEFF# Clean\r\n\r\n:::unknown  \r\n';
  const otherPath = '/test/other.md';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: source, [otherPath]: '# Other\n' }, openFilePath: path });
  await page.goto('/');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Clean');
  await page.locator('.split-editor-toggle-btn').first().click();
  await expect(codeEditor(page)).toContainText('Clean');
  await fs.triggerOpenFiles([otherPath]);
  await expect(page.locator('.tab-bar .tab.active')).toContainText('other.md');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Other');
  // Each file enters Split only after an explicit editing action.
  await page.locator('.split-editor-toggle-btn').first().click();
  await expect(codeEditor(page)).toContainText('Other');
  await page.locator('.tab-bar .tab').filter({ hasText: 'clean.md' }).click();
  await expect(codeEditor(page)).toContainText('Clean');
  await page.locator('.split-editor-toggle-btn').first().click();
  await expect(page.locator('.ProseMirror')).toContainText('Clean');
  await expect.poll(() => page.evaluate(async () => {
    const modulePath = '/src/composables/useSplitView.ts';
    const { useSplitView } = await import(/* @vite-ignore */ modulePath);
    return useSplitView().splitState.value.panes[0].tabs.map((tab: { hasChanges: boolean }) => tab.hasChanges);
  })).toEqual([false, false]);
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe(source);
});

test('a real Visual edit after a Source edit replaces the cached raw source', async ({ page }) => {
  const path = '/test/edit.md';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: 'Original\n' }, openFilePath: path });
  await page.goto('/');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toHaveText('Original');
  await openCodeView(page);
  await codeEditor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('Source Original');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Visual', exact: true }).click();
  const visual = page.locator('.ProseMirror');
  await expect(visual).toHaveText('Source Original');
  await visual.evaluate(element => {
    (element as HTMLElement & { editor: { commands: { focus: (position: string) => void } } }).editor.commands.focus('end');
  });
  await expect(visual).toBeFocused();
  await page.keyboard.insertText(' Visual');
  await expect(visual).toHaveText('Source Original Visual');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe('Source Original Visual\n');
  await openCodeView(page);
  await expect(codeEditor(page)).toContainText('Source Original Visual');
});


test('Split source edits survive a direct switch to Code and then Visual', async ({ page }) => {
  const path = '/test/split-code.md';
  const source = '\uFEFF# Split\r\n\r\n:::unknown  \r\n';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
  await page.goto('/');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Split');
  await page.locator('.split-editor-toggle-btn').first().click();
  await expect(codeEditor(page)).toContainText(':::unknown');
  await codeEditor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('追記');
  await openCodeView(page);
  await expect(page.locator('.split-editor-area')).toHaveCount(0);
  await expect(codeEditor(page)).toContainText('追記');
  await page.getByRole('button', { name: 'Visual', exact: true }).click();
  await expect(page.locator('.ProseMirror')).toContainText('追記');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe(source + '追記');
});

test('Visual undo keeps the earlier unsaved Source change dirty', async ({ page }) => {
  const path = '/test/undo.md';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: 'Original\n' }, openFilePath: path });
  await page.goto('/');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toHaveText('Original');
  await openCodeView(page);
  await codeEditor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('Source Original');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Visual', exact: true }).click();
  const visual = page.locator('.ProseMirror');
  await expect(visual).toHaveText('Source Original');
  await visual.evaluate(element => {
    (element as HTMLElement & { editor: { commands: { focus: (position: string) => void } } }).editor.commands.focus('end');
  });
  await expect(visual).toBeFocused();
  await page.keyboard.insertText(' Visual');
  await expect(visual).toHaveText('Source Original Visual');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(visual).toHaveText('Source Original');
  await expect.poll(() => page.evaluate(async () => {
    const modulePath = '/src/composables/useSplitView.ts';
    const { useSplitView } = await import(/* @vite-ignore */ modulePath);
    return useSplitView().splitState.value.panes[0].tabs[0].hasChanges;
  })).toBe(true);
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe('Source Original\n');
});


test('Source Undo cannot apply another edited tab history to identical file content', async ({ page }) => {
  const first = '/test/source-undo-first.md';
  const second = '/test/source-undo-second.md';
  const fs = await setupTauriMocks(page, {
    initialFs: { [first]: 'Same', [second]: 'Same local' },
    openFilePath: first,
  });
  await page.goto('/');
  await openCodeView(page);
  await fs.triggerOpenFiles([second]);
  await expect(page.locator('.tab.active')).toContainText('source-undo-second.md');
  await openCodeView(page);
  // Both tabs have Source sessions before switching between them, so this
  // exercises editor reuse without an intervening initial read-only view.
  await page.locator('.tab-bar .tab').filter({ hasText: 'source-undo-first.md' }).click();
  await expect(codeEditor(page)).toHaveText('Same');
  await fillCodeEditor(page, 'Same local');
  await page.locator('.tab-bar .tab').filter({ hasText: 'source-undo-second.md' }).click();
  await expect(codeEditor(page)).toHaveText('Same local');
  await codeEditor(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(codeEditor(page)).toHaveText('Same local');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[second]).toBe('Same local');
  await page.locator('.tab-bar .tab').filter({ hasText: 'source-undo-first.md' }).click();
  await expect(codeEditor(page)).toHaveText('Same local');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[first]).toBe('Same local');
});
