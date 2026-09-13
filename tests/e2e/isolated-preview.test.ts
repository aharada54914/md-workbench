import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';

test('preview toggle keeps the editor undo history and original file unchanged', async ({ page }) => {
  const path = '/test/isolated.md';
  const source = '# Original\r\n\r\n日本語の本文  \r\n';
  const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
  await page.goto('/');
  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toContainText('日本語の本文');
  await page.waitForTimeout(400); // inherited hydration dirty-event guard
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' ADDED');
  await expect(editor).toContainText('ADDED');
  await page.getByRole('button', { name: 'Isolated read-only preview', exact: true }).click();
  await expect(page.frameLocator('iframe[title="Isolated document preview"]').getByText(/ADDED/)).toBeVisible();
  await page.getByRole('button', { name: 'Return to editor', exact: true }).click();
  await editor.click();
  await page.keyboard.press('Control+z');
  await expect(editor).not.toContainText('ADDED');
  expect(fs.getFs()[path]).toBe(source);
});

test('isolated document has no script, parent IPC, network or navigation authority', async ({ page }) => {
  await page.goto('/');
  const requests: string[] = [];
  await page.route('https://example.invalid/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.evaluate(async () => {
    const modulePath = '/src/utils/isolated-preview.ts';
    const { buildIsolatedPreviewDocument } = await import(/* @vite-ignore */ modulePath);
    const iframe = document.createElement('iframe');
    iframe.id = 'security-fixture';
    iframe.setAttribute('sandbox', '');
    iframe.srcdoc = buildIsolatedPreviewDocument('# Native boundary\n\n<p onclick="parent.__previewExecuted=true">日本語</p>\n\n<img src="https://example.invalid/tracker">\n\n<svg><foreignObject><script>parent.__previewExecuted=true</script></foreignObject></svg>');
    document.body.appendChild(iframe);
  });
  const frame = page.frameLocator('#security-fixture');
  await expect(frame.getByRole('heading', { name: 'Native boundary' })).toBeVisible();
  await expect(frame.getByText('日本語', { exact: true })).toBeVisible();
  const boundary = await frame.locator('body').evaluate(async () => {
    let parentBlocked = false, networkBlocked = false;
    try { void parent.document; } catch { parentBlocked = true; }
    try { await fetch('https://example.invalid/csp-probe'); } catch { networkBlocked = true; }
    return { parentBlocked, networkBlocked, tauri: '__TAURI_INTERNALS__' in window || '__TAURI__' in window, scripts: document.scripts.length };
  });
  expect(boundary).toEqual({ parentBlocked: true, networkBlocked: true, tauri: false, scripts: 0 });
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => '__previewExecuted' in window)).toBe(false);
});
