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

for (const kind of ['file', 'folder'] as const) {
  test(`denied native ${kind} creation explains the failure and preserves the open document`, async ({ page }) => {
    const fs = await setupTauriMocks(page, {
      initialFs: { [file]: '# Keep current\n' }, workspaceTrees: { [root]: tree },
    });
    await seedWorkspace(page);
    await page.goto('/');
    await openFolder(page, root);
    await page.locator('.tree-row', { hasText: 'note.md' }).dblclick();
    const preview = page.frameLocator('iframe[title="Isolated document preview"]').locator('body');
    await expect(preview).toContainText('Keep current');
    const before = await workspaceState(page);
    const calls = fs.getCalls().filter(call => call.cmd !== 'watch_read');
    await page.evaluate(kind => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, ...args: unknown[]) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const invoke = internals.invoke;
      internals.invoke = (command, ...args) => {
        if (command === (kind === 'file' ? 'create_md_file' : 'create_folder')) {
          return Promise.reject({ code: 'permission_required', message: 'Native detail' });
        }
        return invoke(command, ...args);
      };
    }, kind);
    await page.locator('.ws-section-name').click({ button: 'right' });
    await page.locator('.workspace-context-menu').getByRole('button', {
      name: kind === 'file' ? 'New file…' : 'New folder…', exact: true,
    }).click();
    await page.locator('.wid-input').fill('new-item');
    const alert = page.waitForEvent('dialog').then(async dialog => {
      const message = dialog.message();
      await dialog.accept();
      return message;
    });
    await page.locator('.wid-panel').getByRole('button', { name: 'Create', exact: true }).click();
    expect(await alert).toBe(`Error: ${permission}`);
    await expect(page.locator('.wid-panel')).toHaveCount(0);
    await expect(preview).toContainText('Keep current');
    await expect(page.locator('.tree-label')).toHaveText('note.md');
    expect(await workspaceState(page)).toEqual(before);
    expect(fs.getCalls().filter(call => call.cmd !== 'watch_read')).toEqual(calls);
  });
}

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
  const calls = fs.getCalls().filter(call => call.cmd !== 'watch_read');
  await openFolder(page, null);
  await expect.poll(() => page.evaluate(() => (window as any).__mockNativeFsCalls.filter((call: any) => call.cmd === 'native_pick_workspace').length)).toBe(2);
  expect(await workspaceState(page)).toEqual(before);
  expect(fs.getCalls().filter(call => call.cmd !== 'watch_read')).toEqual(calls);
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

test('multi-delete reports failed items once and refreshes after each result', async ({ page }) => {
  const other = `${root}/other.md`;
  const mutableTree: WorkspaceNode = {
    ...tree, children: [...tree.children!, { name: 'other.md', path: other, kind: 'file' }],
  };
  const fs = await setupTauriMocks(page, {
    initialFs: { [file]: '# Keep current\n', [other]: '# Other\n' },
    workspaceTrees: { [root]: mutableTree },
  });
  const deleted: string[] = [];
  await page.exposeFunction('__testDeleteWorkspaceItem', (path: string) => {
    deleted.push(path);
    if (path === file) return false;
    mutableTree.children = mutableTree.children!.filter(child => child.path !== path);
    return true;
  });
  await seedWorkspace(page);
  await page.goto('/');
  await openFolder(page, root);
  await page.locator('.tree-row', { hasText: 'note.md' }).dblclick();
  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __testDeleteWorkspaceItem: (path: string) => Promise<boolean>;
    };
    const invoke = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'delete_path') {
        if (!await host.__testDeleteWorkspaceItem(args!.path as string)) {
          throw { code: 'filesystem_error', partial: true, removed: 0 };
        }
        return;
      }
      return invoke(command, args);
    };
  });
  await page.locator('.tree-row', { hasText: 'other.md' }).click({ modifiers: ['ControlOrMeta'] });
  await page.locator('.tree-row', { hasText: 'note.md' }).click({ button: 'right' });
  await page.locator('.workspace-context-menu').getByRole('button', { name: 'Delete', exact: true }).click();
  const messages: string[] = [];
  page.on('dialog', async dialog => { messages.push(dialog.message()); await dialog.accept(); });
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toBe(`${file}: Deletion stopped and some items may have been removed. Check the refreshed folder before trying again.`);
  expect(deleted).toEqual([file, other]);
  await expect(page.locator('.tree-label')).toHaveText('note.md');
  expect(fs.getCalls().filter(call => call.cmd === 'read_tree')).toHaveLength(3);
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toContainText('Keep current');
});


for (const entry of ['tab', 'tree', 'root'] as const) {
  test(`denied file manager reveal from ${entry} is visible and preserves document and workspace`, async ({ page }) => {
    const fs = await setupTauriMocks(page, {
      initialFs: { [file]: '# Keep current\n' }, workspaceTrees: { [root]: tree },
    });
    const reveals: unknown[] = [];
    await page.exposeFunction('__testReveal', (args: unknown) => { reveals.push(args); });
    await seedWorkspace(page);
    await page.goto('/');
    await openFolder(page, root);
    await page.locator('.tree-row', { hasText: 'note.md' }).dblclick();
    const preview = page.frameLocator('iframe[title="Isolated document preview"]').locator('body');
    await expect(preview).toContainText('Keep current');
    const before = await workspaceState(page);
    const calls = fs.getCalls().filter(call => call.cmd !== 'watch_read');
    await page.evaluate(() => {
      const host = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
        __testReveal: (args: unknown) => Promise<void>;
      };
      const invoke = host.__TAURI_INTERNALS__.invoke;
      host.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'reveal_in_os') {
          await host.__testReveal(args);
          throw { code: 'permission_required', message: 'Native detail' };
        }
        return invoke(command, args);
      };
    });
    const alert = page.waitForEvent('dialog').then(async dialog => {
      const message = dialog.message();
      await dialog.accept();
      return message;
    });
    if (entry === 'root') {
      await page.locator('.ws-section').getByRole('button', { name: 'Reveal in file manager', exact: true }).click();
    } else {
      await page.locator(entry === 'tab' ? '.tab' : '.tree-row', { hasText: 'note.md' }).click({ button: 'right' });
      await page.locator(entry === 'tab' ? '.tab-context-menu' : '.workspace-context-menu')
        .getByRole('button', { name: 'Reveal in file manager', exact: true }).click();
    }
    expect(await alert).toBe('Open this file or folder again with the file or folder picker to grant access.');
    expect(reveals).toEqual([{ path: entry === 'root' ? root : file }]);
    await expect(preview).toContainText('Keep current');
    expect(await workspaceState(page)).toEqual(before);
    expect(fs.getCalls().filter(call => call.cmd !== 'watch_read')).toEqual(calls);
  });
}
