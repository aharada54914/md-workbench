import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const host = 'http://mdwdiagramhost.localhost';
const child = 'http://mdwdiagramfixture.localhost';
const foreign = 'http://mdwdiagramforeign.localhost';

test.beforeEach(async ({ page }) => {
  // This validates actual browser frame provenance using the compiled fixture
  // sources. It does not emulate Tauri IPC or establish native WebView2 results.
  await page.route(/^http:\/\/mdwdiagram(host|fixture|foreign)\.localhost\//, async route => {
    const url = new URL(route.request().url());
    const name = url.pathname === '/'
      ? url.origin === host ? 'host.html' : url.origin === child ? 'child.html' : 'peer.html'
      : url.pathname === '/sibling.html' ? 'peer.html' : url.pathname.slice(1);
    if (!['host.html', 'child.html', 'peer.html', 'host.mjs', 'child.mjs', 'peer.mjs', 'protocol.mjs'].includes(name)) {
      await route.fulfill({ status:403, body:'' }); return;
    }
    const body = (await readFile(`src-tauri/src/diagram_spike/${name}`, 'utf8'))
      .replaceAll('__NONCE__', 'a'.repeat(32)).replaceAll('__HOST_ORIGIN__', host)
      .replaceAll('__CHILD_ORIGIN__', child).replaceAll('__FOREIGN_ORIGIN__', foreign)
      .replaceAll('__FRAME_PROBE__', 'true');
    await route.fulfill({ body, contentType:name.endsWith('.html') ? 'text/html' : 'text/javascript', headers:{
      'Content-Security-Policy':`default-src 'none'; script-src 'self'; connect-src 'none'; frame-src ${url.origin === host ? `${child} ${foreign}` : "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'; img-src 'none'; font-src 'none'; worker-src 'none'`,
      'X-Content-Type-Options':'nosniff',
    } });
  });
  await page.goto(host);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __diagramReport:{frames:{sibling:unknown}} }).__diagramReport.frames.sibling)).toBeTruthy();
});

test('real same-source wrong-origin and correct-origin sibling are ignored before a valid roundtrip', async ({ page }) => {
  const report = await page.evaluate(() => (window as unknown as { __diagramReport:{status:string;frames:unknown} }).__diagramReport);
  expect(report.status).toBe('starting');
  expect(report.frames).toMatchObject({
    foreign:{ selectedSource:true, origin:foreign, result:'ignored' },
    sibling:{ selectedSource:false, origin:child, result:'ignored' },
  });
  const frame = page.frames().find(value => value.url() === `${child}/`)!;
  await expect.poll(() => frame.evaluate(() => typeof (window as unknown as {__diagramStart?:unknown}).__diagramStart)).toBe('function');
  await frame.evaluate(() => (window as unknown as {__diagramStart:()=>void}).__diagramStart());
  await expect.poll(() => page.evaluate(() => (window as unknown as {__diagramReport:{status:string}}).__diagramReport.status)).toBe('passed_roundtrip');
});

test('genuine selected-child malformed command retires the active gate and later messages leave it unchanged', async ({ page }) => {
  const frame = page.frames().find(value => value.url() === `${child}/`)!;
  await frame.evaluate(hostOrigin => parent.postMessage('{"cmd":"native_read_path","payload":{}}', hostOrigin), host);
  await expect.poll(() => page.evaluate(() => (window as unknown as {__diagramReport:{status:string}}).__diagramReport.status)).toBe('schema');
  const terminal = await page.evaluate(() => (window as unknown as {__diagramReport:unknown}).__diagramReport);
  expect(terminal).toMatchObject({ frames:{selectedRejected:{ selectedSource:true, origin:child, reason:'schema' }} });
  await frame.evaluate(hostOrigin => parent.postMessage('{"cmd":"native_read_path","payload":{}}', hostOrigin), host);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as unknown as {__diagramReport:unknown}).__diagramReport)).toEqual(terminal);
});
