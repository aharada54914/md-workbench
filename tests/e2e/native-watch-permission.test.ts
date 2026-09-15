import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { fillCodeEditor, getCodeEditorValue, openCodeView } from './helpers/code-editor';

const path = '/test/current.md';
const saved = '/test/new-save.md';
const original = '\uFEFF# Original\r\n\r\nraw  \r\n';
const warning = (page: Page) => page.getByTestId('monitoring-warning');
const select = async (page: Page, paths: string[]) => {
  await page.evaluate(paths => { (window as any).__mockDocumentSelection = paths; }, paths);
  await warning(page).getByRole('button').click();
};

test('Save As preserves exact bytes and shows a persistent monitoring warning until explicit same-path selection', async ({ page }) => {
  const fs = await setupTauriMocks(page, { initialFs: { [path]: original }, openFilePath: path });
  await page.goto('/'); await expect(page.locator('.tab.active')).toContainText('current.md');
  await page.evaluate(saved => { (window as any).__mockDialogSavePath = saved; }, saved);
  await page.keyboard.press('Control+Shift+s');
  await expect.poll(() => fs.getFs()[saved]).toBe(original);
  await expect(warning(page)).toContainText('Saved, but');
  await expect(page.locator('.tab.active .tab-unsaved')).not.toBeVisible();
  await openCodeView(page); await fillCodeEditor(page, '# Dirty pending\n');
  await select(page, []); // cancel never resets saved path, warning or dirty source
  await expect(warning(page)).toBeVisible();
  await expect(page.locator('.tab.active')).toContainText('new-save.md');
  await expect.poll(() => getCodeEditorValue(page)).toBe('# Dirty pending\n');
  await select(page, [saved]);
  await expect(warning(page)).not.toBeVisible();
  await expect.poll(() => getCodeEditorValue(page)).toBe('# Dirty pending\n');
  await expect(page.locator('.tab.active .tab-unsaved')).toBeVisible();
  expect(fs.getFs()[saved]).toBe(original);
  await fs.triggerExternalChange(saved, '# New disk\r\n');
  await expect(page.locator('.conflict-panel')).toBeVisible();
  await expect.poll(() => getCodeEditorValue(page)).toBe('# Dirty pending\n');
  await page.locator('.conflict-panel button').filter({ hasText: /load external/i }).click();
  await expect.poll(() => getCodeEditorValue(page)).toBe('# New disk\n');
});

test('revocation is visible, manual Reload cannot bypass it, and choosing another file leaves the paused document intact', async ({ page }) => {
  const other = '/test/other.md';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: original, [other]: '# Other' }, openFilePath: path });
  await page.goto('/'); await expect(page.locator('.tab.active')).toContainText('current.md');
  await openCodeView(page); await fillCodeEditor(page, '# Local\n');
  await page.evaluate(path => { (window as any).__revokeDocumentGrant(path); }, path);
  await expect(warning(page)).toContainText('monitoring is paused');
  const before = fs.getCalls().filter(call => call.cmd === 'read' && call.args === path).length;
  await page.keyboard.press('Control+r');
  await expect(warning(page)).toBeVisible(); await expect.poll(() => getCodeEditorValue(page)).toBe('# Local\n');
  expect(fs.getCalls().filter(call => call.cmd === 'read' && call.args === path)).toHaveLength(before);
  await select(page, [other]);
  await expect(page.locator('.tab.active')).toContainText('other.md'); await expect(warning(page)).not.toBeVisible();
  await page.locator('.tab-bar .tab', { hasText: 'current.md' }).click();
  await expect(warning(page)).toBeVisible(); await expect.poll(() => getCodeEditorValue(page)).toBe('# Local\n');
  await select(page, [path]); await expect(warning(page)).not.toBeVisible();
  await expect.poll(() => getCodeEditorValue(page)).toBe('# Local\n');
  await expect(page.locator('.tab.active .tab-unsaved')).toBeVisible();
});

test('Workspace READ resolves child documents and polling observes external changes without exact-file grants', async ({ page }) => {
  const root = '/work'; const child = '/work/a.md';
  const fs = await setupTauriMocks(page, { initialFs: { [child]: '# From workspace' }, workspaceTrees: {
    [root]: { name: 'work', path: root, kind: 'folder', children: [{ name: 'a.md', path: child, kind: 'file' }] },
  } });
  await page.addInitScript(() => {
    localStorage.setItem('mermark-settings', JSON.stringify({
      language: 'en', ai: { hasSeenFirstRun: true },
      workspace: { openWorkspaces: [], activeWorkspaceId: null, recentRoots: [], sidebarVisible: true },
    }));
  });
  await page.goto('/');
  // Use the real workspace sidebar picker to exercise the descendant opener.
  await page.evaluate(root => { (window as any).__mockWorkspaceSelection = root; }, root);
  await page.locator('.ws-header-menu-root > button').click();
  await page.locator('.ws-menu').getByRole('button', { name: 'Open folder…', exact: true }).click();
  await page.locator('.tree-row', { hasText: 'a.md' }).dblclick();
  await expect(page.locator('.tab.active')).toContainText('a.md');
  await fs.triggerExternalChange(child, '# Workspace changed');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Workspace changed');
  await expect(warning(page)).not.toBeVisible();
});
