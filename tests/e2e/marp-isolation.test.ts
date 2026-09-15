import { expect, test } from '@playwright/test';

test('live preview synchronizes long decks and destroys the previous frame on replacement', async ({ page }) => {
  await page.route('**/marp-lifecycle-probe', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto('/marp-lifecycle-probe');
  await page.evaluate(async () => {
    const livePath = '/src/components/MarpLivePreview.vue';
    const compiled = await (await fetch(livePath)).text();
    const vuePath = compiled.match(/"([^"\n]*\/vue\.js[^"\n]*)"/)?.[1];
    if (!vuePath) throw new Error('No actual Vue runtime');
    const { createApp, h, ref, nextTick } = await import(/* @vite-ignore */ vuePath);
    const { default: Live } = await import(/* @vite-ignore */ livePath);
    const syncPath = '/src/composables/useScrollSync.ts';
    const { useScrollSync } = await import(/* @vite-ignore */ syncPath);
    const sync = useScrollSync(); const component = ref(null);
    const code = document.createElement('div'); code.id = 'code-scroll'; code.style.cssText = 'height:100px;overflow:auto';
    code.innerHTML = '<div style="height:5000px">Source</div>'; document.body.append(code);
    const markdown = ref(Array.from({ length: 100 }, (_, i) => `# Slide ${i + 1}`).join('\n\n---\n\n'));
    const host = document.createElement('div'); host.style.cssText = 'height:300px;width:700px'; document.body.append(host);
    createApp({ setup: () => () => h(Live, { ref: component, markdown: markdown.value,
      onScrollReady: () => { if (component.value?.scrollEl) sync.attach(code, component.value.scrollEl); },
      onScrollReset: sync.detach,
    }) }).mount(host);
    (window as any).__replaceMarp = async () => {
      const previous = host.querySelector('iframe');
      markdown.value = '# Replacement';
      await nextTick();
      return { connected: previous?.isConnected, same: previous === host.querySelector('iframe'), document: !!previous?.contentDocument };
    };
  });
  const scroll = page.frameLocator('.marp-live-frame').locator('.marp-scroll');
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight)).toBeGreaterThan(32_768);
  await expect.poll(() => page.locator('.marp-live-frame').evaluate(el => el.getBoundingClientRect().height)).toBe(300);
  await page.locator('#code-scroll').dispatchEvent('pointerdown');
  await page.locator('#code-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => scroll.evaluate(el => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)))).toBeLessThan(1);
  await scroll.hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => page.locator('#code-scroll').evaluate(el => el.scrollTop)).toBeLessThan(4900);
  expect(await page.evaluate(() => (window as any).__replaceMarp())).toEqual({ connected: false, same: false, document: false });
  await expect(page.frameLocator('.marp-live-frame').getByRole('heading', { name: 'Replacement' })).toBeVisible();
  await expect.poll(() => page.locator('.marp-live-frame').evaluate(el => el.getBoundingClientRect().height)).toBe(300);
});

test('actual Marp live, presentation and standalone output block authored activity', async ({ page, context }) => {
  const requests: string[] = [];
  const routed: string[] = [];
  const failures: string[] = [];
  const observeFailures = (target: typeof page) => target.on('requestfailed', request => {
    if (request.url().includes('__marp_boundary__')) failures.push(request.failure()?.errorText ?? 'unknown');
  });
  observeFailures(page);
  page.on('request', request => { if (request.url().includes('__marp_boundary__')) requests.push(request.url()); });
  await context.route('**/*__marp_boundary__*', route => { routed.push(route.request().url()); return route.abort(); });
  await page.route('**/marp-boundary-probe', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto('/marp-boundary-probe');
  const source = `---\nmarp: true\nstyle: |\n  @import url('https://example.invalid/__marp_boundary__-import');\n  section { background-image: url('https://example.invalid/__marp_boundary__-css'); }\n---\n# 日本語 first\n\n![external](https://example.invalid/__marp_boundary__-image)\n\n[x](https://example.invalid/__marp_boundary__-link)\n\n<img src="https://example.invalid/__marp_boundary__-raw" onerror="parent.__marpExecuted=true">\n\n---\n\n# Second\n\n$x^2$`;
  const output = await page.evaluate(async source => {
    const livePath = '/src/components/MarpLivePreview.vue';
    const dialogPath = '/src/components/MarpPreviewDialog.vue';
    const exportPath = '/src/composables/useMarpExport.ts';
    const compiled = await (await fetch(livePath)).text();
    const vuePath = compiled.match(/"([^"\n]*\/vue\.js[^"\n]*)"/)?.[1];
    if (!vuePath) throw new Error('No actual Vue runtime');
    const { createApp } = await import(/* @vite-ignore */ vuePath);
    const { default: Live } = await import(/* @vite-ignore */ livePath);
    const { default: Dialog } = await import(/* @vite-ignore */ dialogPath);
    const { renderDeck, buildStandaloneHtml } = await import(/* @vite-ignore */ exportPath);
    const live = document.createElement('div'); live.style.cssText = 'height:300px;width:700px'; document.body.append(live);
    const app = createApp(Live, { markdown: source }); app.mount(live);
    const dialog = document.createElement('div'); document.body.append(dialog);
    createApp(Dialog, { markdown: source, title: 'Deck' }).mount(dialog);
    return buildStandaloneHtml(renderDeck(source));
  }, source);
  const live = page.frameLocator('.marp-live-frame');
  const presentation = page.frameLocator('.marp-frame');
  await expect(live.getByRole('heading', { name: '日本語 first' })).toBeVisible();
  await expect(presentation.getByRole('heading', { name: '日本語 first' })).toBeVisible();
  await expect(page.locator('.marp-live-frame')).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(page.locator('.marp-frame')).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect.poll(() => live.locator('.marp-scroll').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.locator('.marp-nav button').last().click();
  await expect(presentation.getByRole('heading', { name: 'Second' })).toBeVisible();
  await expect(presentation.locator('mjx-container, .katex, svg[data-mml-node]').first()).toBeVisible();
  for (const frame of [live, presentation]) {
    await expect(frame.locator('a[href], img[src^="https"], script, iframe, meta[http-equiv="refresh"]')).toHaveCount(0);
    await expect(frame.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /script-src 'none'/);
  }
  // Export gets the same protections when opened directly, without iframe sandbox.
  const exported = await context.newPage();
  observeFailures(exported);
  exported.on('request', request => { if (request.url().includes('__marp_boundary__')) requests.push(request.url()); });
  await exported.route('**/standalone-deck', route => route.fulfill({ contentType: 'text/html', body: output }));
  await exported.goto('/standalone-deck');
  await expect(exported.getByRole('heading', { name: 'Second' })).toBeVisible();
  expect(await page.evaluate(() => '__marpExecuted' in window)).toBe(false);
  expect(requests).toHaveLength(6); // Two CSP-denied CSS loads in each of three documents.
  expect(failures).toHaveLength(6);
  expect(failures).toEqual(Array(6).fill('csp'));
  expect(routed).toEqual([]);
  const positive = page.waitForRequest(request => request.url().includes('__marp_boundary__-positive'));
  await page.evaluate(() => { const img = document.createElement('img'); img.src = '/__marp_boundary__-positive'; document.body.append(img); });
  await positive;
  await expect.poll(() => routed.length).toBe(1);
  expect(requests).toHaveLength(7);
});

test('standalone serialization blocks style termination and active SVG while retaining a data image', async ({ page }) => {
  const routed: string[] = [];
  await page.route('**/*__marp_escape__*', route => { routed.push(route.request().url()); return route.abort(); });
  await page.route('**/marp-serialization-probe', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto('/marp-serialization-probe');
  const html = await page.evaluate(async () => {
    const module = '/src/composables/useMarpExport.ts';
    const { buildStandaloneHtml } = await import(/* @vite-ignore */ module);
    return buildStandaloneHtml({
      css: '</style><meta http-equiv="refresh" content="0;url=/__marp_escape__-css"><script>window.__marpEscape=true</script><style>',
      html: '<section><h1>Safe slide</h1><svg onload="window.__marpEscape=true"><foreignObject><iframe src="/__marp_escape__-frame"></iframe><a href="/__marp_escape__-link" target="_top">disabled link</a></foreignObject><animate attributeName="href" values="/__marp_escape__-animate"></animate></svg><script>window.__marpEscape=true</script><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHc8AAAAASUVORK5CYII=" onload="window.__marpEscape=true"></section>',
    });
  });
  await page.route('**/serialized-deck', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('/serialized-deck');
  await expect(page.getByRole('heading', { name: 'Safe slide' })).toBeVisible();
  await expect.poll(() => page.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.locator('script, iframe, animate, a[href], meta[http-equiv="refresh"]')).toHaveCount(0);
  expect(await page.evaluate(() => '__marpEscape' in window)).toBe(false);
  expect(page.url()).toContain('/serialized-deck');
  expect(routed).toEqual([]);
});
