import { expect, test } from '@playwright/test';

test('real PM clipboard adapter keeps raw HTML inert while preserving copy, cut, paste and internal drag', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('__clipboard_sentinel__')) requests.push(request.url());
  });
  await page.route('**/*__clipboard_sentinel__*', route => route.abort());
  // Deliberately no CSP: network inactivity must come from the DOM boundary.
  await page.route('**/inert-clipboard-probe', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto('/inert-clipboard-probe');
  const result = await page.evaluate(async () => {
    const path = '/tests/e2e/helpers/inert-clipboard-probe.ts';
    const { runInertClipboardProbe } = await import(/* @vite-ignore */ path);
    return runInertClipboardProbe();
  });
  expect(result.activeAdoptions).toEqual([]);
  expect(requests).toEqual([]);
  for (const item of result.cases) {
    expect(item.prevented, item.kind).toBe(true);
    expect(item.liveImages, item.kind).toBe(0);
    if (['missing-copy', 'missing-cut', 'missing-paste', 'composing-paste', 'empty-paste', 'copy'].includes(item.kind)) {
      expect(item.model, item.kind).toEqual(item.before);
    }
    if (['copy', 'cut', 'internal-drop'].includes(item.kind)) {
      expect(item.html, item.kind).toContain(`src="${item.rawSrc}"`);
      expect(item.html, item.kind).toContain('data-pm-slice');
    }
    if (item.kind === 'cut') expect(item.model.content.map((node: { type: string }) => node.type)).toEqual(['paragraph']);
    if (item.kind === 'paste') {
      expect(item.observedPaste).toBe(1);
      expect(JSON.stringify(item.model)).toContain('"type":"bold"');
      expect(JSON.stringify(item.model)).toContain('/__clipboard_sentinel__-paste.png');
    }
    if (item.kind === 'internal-drop') {
      // StarterKit appends its empty trailing paragraph after the moved image.
      expect(item.model.content.map((node: { type: string }) => node.type)).toEqual(['paragraph', 'image', 'paragraph']);
      expect(item.model.content[0].content).toEqual([{ type: 'text', text: 'tail' }]);
      expect(item.model.content[1].attrs.src).toBe(item.rawSrc);
    }
    if (item.kind === 'external-drop') expect(JSON.stringify(item.model)).toContain('/__clipboard_sentinel__-external.png');
  }
  // Positive control proves this fixture really observes active-document fetch.
  await page.evaluate(() => {
    const image = document.createElement('img');
    image.src = '/__clipboard_sentinel__-positive-control.png';
    document.body.appendChild(image);
  });
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toContain('positive-control');
});
