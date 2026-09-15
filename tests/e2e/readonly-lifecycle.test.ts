import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { codeEditor, openCodeView, startEditing } from './helpers/code-editor';

const preview = (page: Page) => page.frameLocator('iframe[title="Isolated document preview"]').locator('body');

async function trackEngineMounts(page: Page) {
  await page.addInitScript(() => {
    (window as any).__engineMounts = [];
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const selector of ['.ProseMirror', '.cm-editor', '.ai-panel', '.mermaid-node']) {
          if (node.matches(selector) || node.querySelector(selector)) (window as any).__engineMounts.push(selector);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

test('cold open never mounts editing engines or resolves document assets, and Save As preserves bytes', async ({ page }) => {
  const path = '/test/inert.md';
  const copy = '/test/inert-copy.md';
  const raw = '\uFEFF# Read first\r\n\r\n![asset](private.png)\r\n\r\n```mermaid\r\ngraph TD; A-->B\r\n```\r\n\t';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: raw, '/test/private.png': 'secret', [path + '.mermark-ai.tmp']: 'AI recovery' }, openFilePath: path });
  await trackEngineMounts(page);
  await page.goto('/');
  await expect(preview(page)).toContainText('Read first');
  await expect(preview(page)).toContainText('graph TD; A-->B');
  expect(await page.evaluate(() => (window as any).__engineMounts)).toEqual([]);
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual([path]);
  await page.evaluate(copy => { (window as any).__mockDialogSavePath = copy; }, copy);
  await page.keyboard.press('Control+Shift+s');
  await expect.poll(() => fs.getFs()[copy]).toBe(raw);
  expect(await page.evaluate(() => (window as any).__engineMounts)).toEqual([]);
});

test('Source starts directly and editing choices belong to each tab', async ({ page }) => {
  const first = '/test/first.md', second = '/test/second.md';
  const fs = await setupTauriMocks(page, { initialFs: { [first]: 'First\r\n', [second]: 'Second\r\n' }, openFilePath: first });
  await trackEngineMounts(page);
  await page.goto('/');
  await expect(preview(page)).toContainText('First');
  await openCodeView(page);
  await expect(codeEditor(page)).toHaveText('First');
  expect(await page.evaluate(() => (window as any).__engineMounts.includes('.ProseMirror'))).toBe(false);
  await fs.triggerOpenFiles([second]);
  await expect(preview(page)).toContainText('Second');
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await page.locator('.tab', { hasText: 'first.md' }).click();
  await expect(codeEditor(page)).toBeVisible();
  await expect(codeEditor(page)).toHaveText('First');
  await page.locator('.tab', { hasText: 'second.md' }).click();
  await expect(preview(page)).toContainText('Second');
  await startEditing(page);
  await expect(page.locator('.ProseMirror')).toHaveText('Second');
});

test('two document panes activate independently and preserve the editing pane while another reads', async ({ page }) => {
  const first = '/test/left.md', second = '/test/right.md';
  const fs = await setupTauriMocks(page, { initialFs: { [first]: 'Left', [second]: 'Right' }, openFilePath: first });
  await page.goto('/');
  await expect(preview(page)).toContainText('Left');
  await fs.triggerOpenFiles([second]);
  await expect(preview(page)).toContainText('Right');
  await page.evaluate(async () => {
    const modulePath = '/src/composables/useSplitView.ts';
    const { useSplitView } = await import(/* @vite-ignore */ modulePath);
    const view = useSplitView();
    const right = view.splitState.value.panes[0].tabs.find((tab: any) => tab.fileName === 'right.md');
    view.enableSplit();
    view.moveTabBetweenPanes({ tabId: right.id, sourcePaneId: 'left', targetPaneId: 'right' });
    view.setActivePane('left');
  });
  await expect(page.locator('iframe[title="Isolated document preview"]')).toHaveCount(2);
  await startEditing(page);
  await expect(page.locator('.editor-pane[data-pane-id="left"] .ProseMirror')).toBeEditable();
  await expect(page.locator('.editor-pane[data-pane-id="right"] .ProseMirror')).toHaveCount(0);
  await page.locator('.editor-pane[data-pane-id="right"] .tab').click();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expect(page.locator('.editor-pane[data-pane-id="left"] .ProseMirror')).toBeEditable();
});

test('large-file reading pages source without mounting the lazy editor', async ({ page }) => {
  const path = '/test/large-read.md';
  const raw = '# Beginning\r\n' + 'safe source\r\n'.repeat(90_000) + '# End';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: raw }, openFilePath: path });
  await trackEngineMounts(page);
  await page.goto('/');
  await expect(preview(page)).toContainText('# Beginning');
  await expect(page.getByRole('navigation', { name: 'Large document pages' })).toBeVisible();
  expect((await preview(page).textContent())?.length).toBe(raw.slice(0, 65_536).replace(/\r\n?/g, '\n').length);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText(/Source page 2/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__engineMounts)).toEqual([]);
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe(raw);
});


test('Source pastes CRLF once and keeps Undo while temporarily reading', async ({ page }) => {
  const path = '/test/paste-source.md';
  const original = 'before\r\n';
  const pasted = '# Pasted\r\n\r\nend\r\n';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: original }, openFilePath: path });
  await page.goto('/');
  await expect(preview(page)).toContainText('before');
  await openCodeView(page);
  await codeEditor(page).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await codeEditor(page).evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, pasted);
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe(pasted);
  await page.locator('.isolated-preview-toggle').click();
  await expect(preview(page)).toContainText('Pasted');
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await expect(codeEditor(page)).toHaveAttribute('contenteditable', 'false');
  await page.locator('.isolated-preview-toggle').click();
  await codeEditor(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(codeEditor(page)).toHaveText('before');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.getFs()[path]).toBe(original);
});
