import { test, expect, type Page } from '@playwright/test';
import { setupTauriMocks, type MockTabTransfer } from './helpers/tauri-mock';
import { openCodeView, fillCodeEditor, getCodeEditorValue } from './helpers/code-editor';

const filePath = '/test/received.md';
const source = '\uFEFF# Received\r\n\r\n:::unknown  \r\n';
const transfer = (id = 'transfer-1', path = filePath): MockTabTransfer => ({
  id, file_path: path, source_window: 'window-1', target_window: 'main',
});
const acknowledgements = (page: Page) => page.evaluate(() => (window as any).__mockTransferAcks);
async function documents(page: Page) {
  return page.evaluate(async () => {
    const modulePath = '/src/composables/useSplitView.ts';
    const { useSplitView } = await import(/* @vite-ignore */ modulePath);
    return useSplitView().splitState.value.panes.flatMap((pane: any) => pane.tabs)
      .filter((tab: any) => tab.filePath).map((tab: any) => ({
        path: tab.filePath, source: tab.originalMarkdown, pending: tab.pendingMarkdown, dirty: tab.hasChanges,
      }));
  });
}

test('cold pending transfer loads exact source before ACK without starting an editor', async ({ page }) => {
  const fs = await setupTauriMocks(page, {
    initialFs: { [filePath]: source }, pendingTransfers: [transfer()],
  });
  await page.goto('/');
  await expect.poll(() => acknowledgements(page)).toEqual([{ id: 'transfer-1', success: true }]);
  expect(await documents(page)).toEqual([{ path: filePath, source, pending: source, dirty: false }]);
  await expect(page.locator('iframe[title="Isolated document preview"]')).toBeVisible();
  await expect(page.locator('.ProseMirror, .cm-editor')).toHaveCount(0);
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual([filePath]);
});

test('runtime duplicate notifications use host queue and read each file once', async ({ page }) => {
  const secondPath = '/test/second.md';
  const fs = await setupTauriMocks(page, { initialFs: { [filePath]: source, [secondPath]: 'Second\n' } });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await fs.triggerTabTransfers([transfer(), transfer('transfer-2', secondPath)]);
  await Promise.all([fs.triggerTabTransfers([]), fs.triggerTabTransfers([])]);
  await expect.poll(() => acknowledgements(page)).toEqual([
    { id: 'transfer-1', success: true }, { id: 'transfer-2', success: true },
  ]);
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual([filePath, secondPath]);
  expect((await documents(page)).map((tab: any) => tab.path)).toEqual([filePath, secondPath]);
});

test('read failure ACKs false and continues the remaining transfer queue', async ({ page }) => {
  const fs = await setupTauriMocks(page, {
    initialFs: { [filePath]: source },
    pendingTransfers: [transfer('missing', '/test/missing.md'), transfer()],
  });
  await page.goto('/');
  await expect.poll(() => acknowledgements(page)).toEqual([
    { id: 'missing', success: false }, { id: 'transfer-1', success: true },
  ]);
  expect((await documents(page)).map((tab: any) => tab.path)).toEqual([filePath]);
  expect(fs.getCalls().filter(call => call.cmd === 'write')).toEqual([]);
});

test('existing clean target accepts without rereading while dirty target refuses without overwriting', async ({ page }) => {
  const fs = await setupTauriMocks(page, { initialFs: { [filePath]: source }, openFilePath: filePath });
  await page.goto('/');
  await expect(page.locator('iframe[title="Isolated document preview"]')).toBeVisible();
  await fs.triggerTabTransfers([transfer('clean')]);
  await expect.poll(() => acknowledgements(page)).toEqual([{ id: 'clean', success: true }]);
  await openCodeView(page);
  await fillCodeEditor(page, '# Local edits\n');
  await expect.poll(async () => (await documents(page))[0]?.dirty).toBe(true);
  await fs.triggerTabTransfers([transfer('dirty')]);
  await expect.poll(() => acknowledgements(page)).toEqual([
    { id: 'clean', success: true }, { id: 'dirty', success: false },
  ]);
  expect(await getCodeEditorValue(page)).toBe('# Local edits\n');
  expect((await documents(page))[0]).toMatchObject({ source, dirty: true });
  expect(fs.getCalls().filter(call => call.cmd === 'read').map(call => call.args)).toEqual([filePath]);
});

test('ACK race reports failure while keeping received document', async ({ page }) => {
  const fs = await setupTauriMocks(page, { initialFs: { [filePath]: source } });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__mockTransferAckError = 'transfer_expired'; });
  await fs.triggerTabTransfers([transfer()]);
  await expect.poll(() => acknowledgements(page)).toEqual([{ id: 'transfer-1', success: true }]);
  await expect(page.getByText('Could not receive the transferred file. The source tab remains open.')).toBeVisible();
  expect((await documents(page))[0]).toMatchObject({ path: filePath, source, dirty: false });
});

for (const gate of ['read', 'register'] as const) {
  test(`does not ACK while ${gate} is pending${gate === 'register' ? ' and refuses newer target edits' : ''}`, async ({ page }) => {
    const fs = await setupTauriMocks(page, { initialFs: { [filePath]: source } });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
    await page.evaluate(({ gate, filePath }) => {
      const host = window as any;
      const original = host.__TAURI_INTERNALS__.invoke;
      host.__transferGateEntered = false;
      host.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        if ((gate === 'read' && command === 'plugin:fs|read_text_file' && args.path === filePath)
          || (gate === 'register' && command === 'register_open_file' && args.filePath === filePath)) {
          host.__transferGateEntered = true;
          await new Promise<void>(resolve => { host.__releaseTransferGate = resolve; });
        }
        return original(command, args);
      };
    }, { gate, filePath });
    await fs.triggerTabTransfers([transfer()]);
    await expect.poll(() => page.evaluate(() => (window as any).__transferGateEntered)).toBe(true);
    expect(await acknowledgements(page)).toEqual([]);
    if (gate === 'register') {
      await openCodeView(page);
      await fillCodeEditor(page, '# Edited during receipt\n');
      await expect.poll(async () => (await documents(page))[0]?.dirty).toBe(true);
    } else {
      expect(await documents(page)).toEqual([]);
    }
    await page.evaluate(() => (window as any).__releaseTransferGate());
    await expect.poll(() => acknowledgements(page)).toEqual([{ id: 'transfer-1', success: gate === 'read' }]);
    if (gate === 'register') expect(await getCodeEditorValue(page)).toBe('# Edited during receipt\n');
    expect(fs.getCalls().filter(call => call.cmd === 'write')).toEqual([]);
  });
}
