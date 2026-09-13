// Disposable Windows native release exercise. No browser/Tauri API mocks.
// CDP is enabled ONLY in the launched test process environment, never app config.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Restricted to disposable GitHub-hosted Windows runners');
}
const [binaryArg, outArg, appName] = process.argv.slice(2);
if (!binaryArg || !outArg || !appName) throw new Error('Usage: windows_native.mjs BINARY OUT APP_NAME');
const binary = resolve(binaryArg), out = resolve(outArg);
await mkdir(out, { recursive: false });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const trials = [], owned = new Set();
const port = 9222;
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` };
const report = {
  schema: 1, app: appName, binary_sha256: hash(await readFile(binary)),
  commit: process.env.GITHUB_SHA, runner_os: process.env.RUNNER_OS,
  runner_image: process.env.ImageOS, runner_image_version: process.env.ImageVersion,
  status: 'running', trials,
  limitations: [
    'Native Windows Server runner, not Windows 11 physical hardware or Japanese IME acceptance.',
    'CDP plus screenshot observation includes protocol/polling overhead; diagnostic upper bounds, not production benchmark acceptance.',
    'Cold means application process restart, not reboot or flushed OS cache.',
    'Warm means second-instance file forwarding to an existing application.',
    'Default visual editor; AI and diagram editors are not invoked.',
  ],
};
const fixtures = [];
for (const [name, newline, bom] of [['lf', '\n', ''], ['crlf', '\r\n', ''], ['bom-crlf', '\r\n', '\uFEFF']]) {
  const marker = `MDW-${name}-日本語表示確認`;
  const path = join(out, `${name}.md`);
  const source = bom + [`# ${marker}`, '', '日本語の本文を実際のWindows WebViewで表示する。', '', '```text', '$not_math$', '```', '', '$$a+b$$', '', 'MDW-END-本文末尾', ''].join(newline);
  await writeFile(path, source, { flag: 'wx' });
  fixtures.push({ path, marker, sha256: hash(Buffer.from(source)) });
}
function launch(fixture) {
  const child = spawn(binary, [fixture.path], { env, stdio: 'ignore' });
  child.on('error', () => {});
  if (!child.pid) throw new Error('Native process launch failed');
  owned.add(child.pid);
  child.once('exit', () => owned.delete(child.pid));
  return child;
}
async function connect() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); }
    catch { await delay(100); }
  }
  throw new Error('Native WebView CDP endpoint unavailable');
}
async function observe(browser, fixture, imagePath) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      const heading = page.getByRole('heading', { name: fixture.marker, exact: true });
      if (!await heading.isVisible().catch(() => false)) continue;
      await page.getByText('MDW-END-本文末尾', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      // A screenshot is a renderer-frame witness, not a guessed sleep or window title.
      await page.screenshot({ path: imagePath });
      return { url: page.url(), viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, userAgent: navigator.userAgent })) };
    }
    await delay(50);
  }
  throw new Error(`No visible native document body: ${fixture.marker}`);
}
function killOwned(pid) {
  if (!owned.has(pid)) throw new Error('Unowned process termination refused');
  // Exact PID tree on a disposable runner. Never kill by process name.
  try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' }); } catch {}
  owned.delete(pid);
}
async function verifyInputs() {
  for (const fixture of fixtures) if (hash(await readFile(fixture.path)) !== fixture.sha256) throw new Error('Viewing changed source bytes');
}
try {
  let child, browser;
  for (let index = 0; index < 30; index++) {
    const fixture = fixtures[index % fixtures.length];
    const begin = process.hrtime.bigint();
    child = launch(fixture);
    browser = await connect();
    const view = await observe(browser, fixture, join(out, 'latest-frame.png'));
    trials.push({ mode: 'cold-process', index, fixture: fixture.sha256, observed_ms: Number(process.hrtime.bigint() - begin) / 1e6, view, status: 'success' });
    await browser.close();
    killOwned(child.pid);
    await verifyInputs();
    await writeFile(join(out, 'native-results.json'), JSON.stringify(report, null, 2));
  }
  child = launch(fixtures[0]);
  browser = await connect();
  await observe(browser, fixtures[0], join(out, 'latest-frame.png'));
  for (let index = 0; index < 50; index++) {
    // Alternate distinct documents so an already-visible frame cannot pass.
    const fixture = fixtures[(index + 1) % fixtures.length];
    const begin = process.hrtime.bigint();
    launch(fixture);
    const view = await observe(browser, fixture, join(out, 'latest-frame.png'));
    trials.push({ mode: 'warm', index, fixture: fixture.sha256, observed_ms: Number(process.hrtime.bigint() - begin) / 1e6, view, status: 'success' });
    await verifyInputs();
    await writeFile(join(out, 'native-results.json'), JSON.stringify(report, null, 2));
  }
  await browser.close();
  killOwned(child.pid);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error);
  process.exitCode = 1;
} finally {
  for (const pid of owned) killOwned(pid);
  await writeFile(join(out, 'native-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ app: appName, status: report.status, completed_trials: trials.length, error: report.error }));
}
