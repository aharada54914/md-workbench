import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';

async function openTabPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const modulePath = '/src/composables/useSplitView.ts';
    const { useSplitView } = await import(/* @vite-ignore */ modulePath);
    return useSplitView().splitState.value.panes.flatMap((pane: { tabs: { filePath: string | null }[] }) =>
      pane.tabs.map(tab => tab.filePath).filter(Boolean));
  });
}

const documents = {
  '/test/start.md': 'Start\n',
  '/test/日本語 one.md': 'First\n',
  '/test/two.md': 'Second\n',
  '/test/three.md': 'Third\n',
};

test('drains every startup file in order without duplicate tabs', async ({ page }) => {
  const paths = ['/test/日本語 one.md', '/test/two.md', '/test/three.md'];
  const fs = await setupTauriMocks(page, { initialFs: documents, openFilePaths: [paths[0], paths[1], paths[0], paths[2]] });
  await page.goto('/');
  await expect.poll(() => openTabPaths(page)).toEqual(paths);
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toHaveText('Third');
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual(paths);
});

test('opens a warm native batch while keeping existing tabs', async ({ page }) => {
  const fs = await setupTauriMocks(page, { initialFs: documents, openFilePath: '/test/start.md' });
  await page.goto('/');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toHaveText('Start');
  await fs.triggerOpenFiles(['/test/日本語 one.md', '/test/two.md']);
  await expect.poll(() => openTabPaths(page)).toEqual(['/test/start.md', '/test/日本語 one.md', '/test/two.md']);
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toHaveText('Second');
});

test('overlapping native notifications drain queued files once in order', async ({ page }) => {
  const fs = await setupTauriMocks(page, { initialFs: documents, openFilePath: '/test/start.md' });
  await page.goto('/');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toHaveText('Start');
  await Promise.all([
    fs.triggerOpenFiles(['/test/日本語 one.md', '/test/two.md']),
    fs.triggerOpenFiles(['/test/two.md', '/test/three.md']),
  ]);
  const paths = ['/test/start.md', '/test/日本語 one.md', '/test/two.md', '/test/three.md'];
  await expect.poll(() => openTabPaths(page)).toEqual(paths);
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toHaveText('Third');
  // A notification with an empty queue must neither reopen nor reread a file.
  await fs.triggerOpenFiles([]);
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual(paths);
});


test('a secondary document becomes queue owner when main closes before consuming', async ({ page }) => {
  const paths = ['/test/日本語 one.md', '/test/two.md'];
  const fs = await setupTauriMocks(page, {
    initialFs: documents,
    openFilePaths: paths,
    windowLabel: 'window-2',
    windowLabels: ['window-print', 'window-preview', 'window-10', 'main', 'window-2'],
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__nativeOpenDrainCalls)).toBeGreaterThan(0);
  expect(await openTabPaths(page)).toEqual([]);
  await fs.destroyNativeWindow('main');
  await expect.poll(() => openTabPaths(page)).toEqual(paths);
  await fs.triggerOpenFiles(['/test/three.md']);
  await expect.poll(() => openTabPaths(page)).toEqual([...paths, '/test/three.md']);
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual([...paths, '/test/three.md']);
});

test('a replacement owner drains cold requests after registering its consumer', async ({ page }) => {
  const fs = await setupTauriMocks(page, {
    initialFs: documents,
    openFilePath: '/test/start.md',
    windowLabel: 'window-3',
    windowLabels: ['window-print', 'window-3'],
  });
  await page.goto('/');
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').locator('body')).toHaveText('Start');
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual(['/test/start.md']);
});

test('a print or preview caller cannot consume pending documents', async ({ page }) => {
  const fs = await setupTauriMocks(page, {
    initialFs: documents,
    openFilePath: '/test/start.md',
    windowLabel: 'window-print',
    windowLabels: ['window-print', 'window-preview'],
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await fs.triggerOpenFiles(['/test/two.md']);
  const queued = await page.evaluate(async () => {
    const api = (window as any).__TAURI_INTERNALS__;
    return [await api.invoke('get_open_file_paths'), await api.invoke('get_open_file_path')];
  });
  expect(queued).toEqual([[], null]);
  expect(fs.getCalls().filter(call => call.cmd === 'read')).toEqual([]);
});
