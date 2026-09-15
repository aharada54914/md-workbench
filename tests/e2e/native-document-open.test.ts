import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';

const preview = (page: Page) => page.frameLocator('iframe[title="Isolated document preview"]').locator('body');
const permissionNotice = (page: Page) => page.getByText('Access to this document is required. Select it again using Open File.', { exact: true });

async function selectDocuments(page: Page, paths: string[]) {
  await page.evaluate(paths => { (window as any).__mockDocumentSelection = paths; }, paths);
  await page.keyboard.press('Control+o');
}

test('native picker opens multiple files in order and preserves BOM CRLF bytes on Save As', async ({ page }) => {
  const paths = ['/test/first.md', '/test/日本語 second.md'];
  const raw = '\uFEFF# Second\r\n\r\nraw  \r\n\t';
  const fs = await setupTauriMocks(page, { initialFs: { [paths[0]]: '# First\n', [paths[1]]: raw } });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await selectDocuments(page, [paths[0], paths[1], paths[0]]);
  // Repeated aliases retain final focus using their latest host identity.
  await expect(preview(page)).toContainText('First');
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
  expect(await page.locator('.tab-bar .tab').allTextContents()).toEqual([expect.stringContaining('first.md'), expect.stringContaining('日本語 second.md')]);
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual(paths);
  await page.locator('.tab-bar .tab', { hasText: '日本語 second.md' }).click();
  await expect(preview(page)).toContainText('Second');
  await page.evaluate(() => { (window as any).__mockDialogSavePath = '/test/copy.md'; });
  await page.keyboard.press('Control+Shift+s');
  await expect.poll(() => fs.getFs()['/test/copy.md']).toBe(raw);
  await expect(page.locator('.ProseMirror')).toHaveCount(0);
});

test('native picker cancellation leaves the current file and editor untouched', async ({ page }) => {
  const fs = await setupTauriMocks(page, { initialFs: { '/test/current.md': '# Current\n' }, openFilePath: '/test/current.md' });
  await page.goto('/');
  await expect(preview(page)).toContainText('Current');
  const before = fs.getCalls().filter(call => call.cmd === 'read');
  await selectDocuments(page, []);
  await expect.poll(() => page.evaluate(() => (window as any).__mockNativeFsCalls.some((call: any) => call.cmd === 'native_pick_documents'))).toBe(true);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
  await expect(preview(page)).toContainText('Current');
  expect(fs.getCalls().filter(call => call.cmd === 'read')).toEqual(before);
  await expect(page.locator('.ProseMirror')).toHaveCount(0);
});

test('recent path has no authority until the user selects it again', async ({ page }) => {
  const path = '/test/recent.md';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: '# Authorized later\n' } });
  await page.addInitScript(path => localStorage.setItem('mermark-recent-files', JSON.stringify([{ filePath: path, fileName: 'recent.md', openedAt: 1 }])), path);
  await page.goto('/');
  await page.locator('.open-split-button .chevron-btn').first().click();
  await page.locator('.dropdown-recent-item', { hasText: 'recent.md' }).click();
  await expect(permissionNotice(page)).toBeVisible();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
  await expect(page.locator('.tab-bar .tab')).not.toContainText('recent.md');
  expect(fs.getCalls().filter(call => call.cmd === 'read')).toEqual([]);
  const registered = await page.evaluate(() => (window as any).__mockDocumentRegistrations);
  expect(registered).toEqual([]);
  await selectDocuments(page, [path]);
  await expect(preview(page)).toContainText('Authorized later');
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual([path]);
  await expect.poll(() => page.evaluate(() => (window as any).__mockDocumentRegistrations.map((entry: any) => entry.filePath))).toEqual([path]);
});

test('restored session paths are denied visibly without legacy reads or replaced tabs', async ({ page }) => {
  const path = '/test/session.md';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: '# Must not load\n' } });
  await page.addInitScript(path => localStorage.setItem('mermark-session', JSON.stringify({ activePaneId: 'left', panes: [{ id: 'left', activeTabId: 'old', tabs: [{ filePath: path, fileName: 'session.md' }] }] })), path);
  await page.goto('/');
  await expect(permissionNotice(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
  await expect(page.locator('.tab-bar .tab')).not.toContainText('session.md');
  expect(fs.getCalls().filter(call => call.cmd === 'read')).toEqual([]);
});

test('a failed native selection does not prevent the following selected document opening', async ({ page }) => {
  const fs = await setupTauriMocks(page, { initialFs: { '/test/next.md': '# Next\n' } });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await selectDocuments(page, ['/test/missing.md', '/test/next.md']);
  await expect(page.getByText('Could not open the document.', { exact: true })).toBeVisible();
  await expect(preview(page)).toContainText('Next');
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual(['/test/missing.md', '/test/next.md']);
});
