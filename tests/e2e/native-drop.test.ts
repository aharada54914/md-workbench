import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import type { NativeDrop, NativeGrant } from '../../src/services/nativeFs';

function grant(path: string, kind: NativeGrant['kind'] = 'document'): NativeGrant {
  return { id: `selected:${path}`, path, kind, read: true, write: kind === 'document' };
}
function drop(id: string, grants: NativeGrant[]): NativeDrop {
  return { id, grants, errors: [], position: { x: 800, y: 400 } };
}

test('completed native drops queued before startup open documents with exact source and no hover event', async ({ page }) => {
  const files = ['/test/first.txt', '/test/second.mermark'];
  const raw = '\uFEFF# Second\r\n\r\nraw  \r\n';
  const fs = await setupTauriMocks(page, {
    initialFs: { [files[0]]: '# First\n', [files[1]]: raw },
    pendingDrops: [drop('startup', files.map(path => grant(path)))],
  });
  await page.goto('/');
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Second');
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual(files);
  await expect(page.locator('.ProseMirror')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__mockDialogSavePath = '/test/drop-copy.md'; });
  await page.keyboard.press('Control+Shift+s');
  await expect.poll(() => fs.getFs()['/test/drop-copy.md']).toBe(raw);
});

test('raw renderer drop paths cannot open files or classify paths', async ({ page }) => {
  const fs = await setupTauriMocks(page, { initialFs: { '/test/forged.md': '# Forged\n' } });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await fs.triggerRendererEvent('tauri://drag-drop', { paths: ['/test/forged.md'], position: { x: 800, y: 400 } });
  await fs.triggerRendererEvent('native-drops-pending', { grants: [grant('/test/forged.md')] });
  await fs.triggerRendererEvent('tauri://drag-enter', { paths: ['/test/forged.md'] });
  await fs.triggerRendererEvent('tauri://drag-leave', null);
  await expect(page.locator('.tab-bar .tab')).not.toContainText('forged.md');
  expect(fs.getCalls().filter(call => call.cmd === 'read' || call.cmd === 'read_tree')).toEqual([]);
  await fs.triggerNativeDrops([drop('real', [grant('/test/forged.md')])]);
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Forged');
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual(['/test/forged.md']);
});

test('mixed native drops open documents and a workspace without hover classification', async ({ page }) => {
  const root = '/work/dropped';
  const file = '/test/dropped.md';
  const fs = await setupTauriMocks(page, {
    initialFs: { [file]: '# Dropped document\n' },
    workspaceTrees: { [root]: { name: 'dropped', path: root, kind: 'folder', children: [] } },
  });
  await page.addInitScript(() => localStorage.setItem('mermark-settings', JSON.stringify({
    language: 'en', ai: { hasSeenFirstRun: true }, workspace: { sidebarVisible: false },
  })));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await fs.triggerNativeDrops([drop('mixed', [grant(file), grant(root, 'workspace')])]);
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Dropped document');
  await expect(page.locator('.ws-section-name')).toHaveText('dropped');
  expect(fs.getCalls().filter(call => call.cmd === 'read_tree')).toEqual([{ cmd: 'read_tree', args: root }]);
});

test('host drop errors remain visible while valid selections still open', async ({ page }) => {
  const file = '/test/good.md';
  const fs = await setupTauriMocks(page, { initialFs: { [file]: '# Good\n' } });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await fs.triggerNativeDrops([{ ...drop('partial', [grant(file)]), errors: [{ path: '/denied.md', error: 'permission_required' }] }]);
  await expect(page.getByText('Access to this document is required. Select it again using Open File.', { exact: true })).toBeVisible();
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Good');
});
