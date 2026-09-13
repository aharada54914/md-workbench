import { test, expect } from '@playwright/test';

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
