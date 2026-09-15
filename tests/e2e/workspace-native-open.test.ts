import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import type { WorkspaceNode } from '../../src/services/workspaceFs';

const root = '/work/project';
const file = `${root}/note.md`;
const tree: WorkspaceNode = {
  name: 'project', path: root, kind: 'folder',
  children: [{ name: 'note.md', path: file, kind: 'file' }],
};
const permission = 'Choose this folder again with Open Folder to grant access.';

async function seedWorkspace(page: Page, restored = false) {
  await page.addInitScript(({ root, restored }) => {
    localStorage.setItem('mermark-settings', JSON.stringify({
      language: 'en', ai: { hasSeenFirstRun: true },
      workspace: {
        openWorkspaces: restored ? [{ id: 'restored', rootPath: root, name: 'project' }] : [],
        activeWorkspaceId: restored ? 'restored' : null,
        recentRoots: restored ? [] : [root], sidebarVisible: true,
      },
    }));
  }, { root, restored });
}

async function openFolder(page: Page, selection: string | null) {
  await page.evaluate(selection => { (window as any).__mockWorkspaceSelection = selection; }, selection);
  await page.locator('.ws-header-menu-root > button').click();
  await page.locator('.ws-menu').getByRole('button', { name: 'Open folder…', exact: true }).click();
}

async function workspaceState(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('mermark-settings')!).workspace);
}

for (const restored of [false, true]) {
  test(`${restored ? 'restored' : 'recent'} workspace requires native reselection before reading its tree`, async ({ page }) => {
    const fs = await setupTauriMocks(page, {
      initialFs: { [file]: '# Workspace document\n' }, workspaceTrees: { [root]: tree },
    });
    await seedWorkspace(page, restored);
    await page.goto('/');
    if (!restored) {
      await page.locator('.ws-header-menu-root > button').click();
      await page.locator('.ws-menu-item.recent', { hasText: 'project' }).click();
    }
    await expect(page.locator('.workspace-sidebar [role="alert"]')).toHaveText(permission);
    await expect(page.locator('.ws-section')).toHaveCount(0);
    expect(fs.getCalls().filter(call => call.cmd === 'read_tree' || call.cmd === 'read')).toEqual([]);
    expect((await workspaceState(page)).recentRoots).toContain(root);

    await openFolder(page, root);
    await expect(page.locator('.ws-section-name')).toHaveText('project');
    await expect(page.locator('.tree-label', { hasText: 'note.md' })).toBeVisible();
    await expect(page.locator('.workspace-sidebar [role="alert"]')).toHaveCount(0);
    expect(fs.getCalls().filter(call => call.cmd === 'read_tree')).toEqual([{ cmd: 'read_tree', args: root }]);
    expect((await workspaceState(page)).recentRoots).not.toContain(root);
    await page.locator('.tree-row', { hasText: 'note.md' }).dblclick();
    await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Workspace document');
    await expect(page.locator('.ProseMirror')).toHaveCount(0);
    expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual([file]);
  });
}

test('workspace picker cancellation preserves the open tree, current document and persisted workspace', async ({ page }) => {
  const fs = await setupTauriMocks(page, {
    initialFs: { [file]: '# Keep current\n' }, workspaceTrees: { [root]: tree },
  });
  await seedWorkspace(page);
  await page.goto('/');
  await openFolder(page, root);
  await page.locator('.tree-row', { hasText: 'note.md' }).dblclick();
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Keep current');
  const before = await workspaceState(page);
  const calls = fs.getCalls().slice();
  await openFolder(page, null);
  await expect.poll(() => page.evaluate(() => (window as any).__mockNativeFsCalls.filter((call: any) => call.cmd === 'native_pick_workspace').length)).toBe(2);
  expect(await workspaceState(page)).toEqual(before);
  expect(fs.getCalls()).toEqual(calls);
  await expect(page.locator('.ws-section-name')).toHaveText('project');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Keep current');
  await expect(page.locator('.workspace-sidebar [role="alert"]')).toHaveCount(0);
});

test('cancelling reselection after permission denial keeps the error and recent entry', async ({ page }) => {
  const fs = await setupTauriMocks(page, { initialFs: { [file]: '# Not granted\n' }, workspaceTrees: { [root]: tree } });
  await seedWorkspace(page, true);
  await page.goto('/');
  await expect(page.locator('.workspace-sidebar [role="alert"]')).toHaveText(permission);
  const before = await workspaceState(page);
  await openFolder(page, null);
  await expect.poll(() => page.evaluate(() => (window as any).__mockNativeFsCalls.some((call: any) => call.cmd === 'native_pick_workspace'))).toBe(true);
  expect(await workspaceState(page)).toEqual(before);
  await expect(page.locator('.workspace-sidebar [role="alert"]')).toHaveText(permission);
  await expect(page.locator('.ws-section')).toHaveCount(0);
  expect(fs.getCalls().filter(call => call.cmd === 'read_tree' || call.cmd === 'read')).toEqual([]);
});
