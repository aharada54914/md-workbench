// Disposable Windows native release exercise. No browser/Tauri API mocks.
// CDP is enabled ONLY in the launched test process environment, never app config.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import os from 'node:os';
import { summarizeNative } from './native_summary.mjs';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Restricted to disposable GitHub-hosted Windows runners');
}
const [binaryArg, outArg, appName, functionalFlag] = process.argv.slice(2);
if (functionalFlag && functionalFlag !== '--verify-editor') throw new Error('Unknown functional option');
if (!binaryArg || !outArg || !appName) throw new Error('Usage: windows_native.mjs BINARY OUT APP_NAME');
const binary = resolve(binaryArg), out = resolve(outArg);
await mkdir(out, { recursive: false });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const trials = [], owned = new Map();
let currentTrial = null;
const port = 9222;
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` };
const report = {
  schema: 1, app: appName, binary_sha256: hash(await readFile(binary)),
  commit: process.env.GITHUB_SHA, runner_os: process.env.RUNNER_OS,
  runner_image: process.env.ImageOS, runner_image_version: process.env.ImageVersion,
  environment: { os_release: os.release(), os_version: os.version(), arch: os.arch(), runner_arch: process.env.RUNNER_ARCH,
    processor_architecture: process.env.PROCESSOR_ARCHITECTURE, processor_architew6432: process.env.PROCESSOR_ARCHITEW6432,
    binary_arch: 'x64', cpu: os.cpus()[0]?.model, ram_bytes: os.totalmem(),
    power: execFileSync('powercfg.exe', ['/getactivescheme'], { encoding: 'utf8' }).trim(),
    antivirus: 'GitHub-hosted runner default; no exclusions or protection changes requested',
    ai_state: 'not invoked', diagram_editor_state: 'not invoked' },
  status: 'running', trials,
  limitations: [
    'Disposable hosted Windows VM; the recorded OS and runner architecture identify Server x64 versus Windows 11 ARM running the x64 binary under emulation.',
    'Not Windows 11 x64 physical hardware performance or Japanese IME acceptance.',
    'CDP plus screenshot observation includes protocol/polling overhead; diagnostic upper bounds, not production benchmark acceptance.',
    'Cold means application process restart, not reboot or flushed OS cache.',
    'Warm means second-instance file forwarding to an existing application.',
    'Default visual editor; AI and diagram editors are not invoked.',
  ],
};
const fixtures = [];
for (const [name, newline, bom] of [['lf', '\n', ''], ['crlf', '\r\n', ''], ['bom-crlf', '\r\n', '\uFEFF']]) {
  const marker = `MDW-${name}-日本語の表示テスト`;
  const path = join(out, `${name}.md`);
  const source = bom + [`# ${marker}`, '', '日本語の本文を実際のWindows WebViewで表示する。', '', '```text', '$not_math$', '```', '', '$$a+b$$', '', 'MDW-END-本文末尾', ''].join(newline);
  await writeFile(path, source, { flag: 'wx' });
  fixtures.push({ path, marker, sha256: hash(Buffer.from(source)) });
}
async function watchMemory(pid, name) {
  const directory = join(out, name);
  const child = spawn('python', ['scripts/benchmark/native_memory.py', '--pid', String(pid), '--out', directory], { stdio: 'inherit' });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try { await access(join(directory, 'ready.json')); ready = true; break; } catch {}
    if (child.exitCode !== null) break;
    await delay(20);
  }
  if (!ready) throw new Error('Process-tree observer failed to initialize');
  return async () => {
    await writeFile(join(directory, 'stop'), '', { flag: 'wx' });
    if (await exited !== 0) throw new Error('Incomplete native process-tree memory observation');
    return JSON.parse(await readFile(join(directory, 'memory.json'), 'utf8'));
  };
}
function launch(fixture) {
  const child = spawn(binary, [fixture.path], { env, stdio: 'ignore' });
  child.on('error', () => {});
  if (!child.pid) throw new Error('Native process launch failed');
  owned.set(child.pid, child);
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
      const unobscured = await heading.evaluate(element => {
        const box = element.getBoundingClientRect();
        const x = box.left + box.width / 2, y = box.top + box.height / 2;
        const top = document.elementFromPoint(x, y);
        return box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && !!top && element.contains(top);
      });
      if (!unobscured) throw new Error('Heading is clipped or obscured');
      const session = await context.newCDPSession(page);
      let fonts;
      try {
        await session.send('DOM.enable'); await session.send('CSS.enable');
        await session.send('DOM.getDocument');
        const object = await session.send('Runtime.evaluate', { expression: `Array.from(document.querySelectorAll('h1')).find(e => e.textContent === ${JSON.stringify(fixture.marker)})` });
        const { nodeId } = await session.send('DOM.requestNode', { objectId: object.result.objectId });
        ({ fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId }));
        // The mixed ASCII/Japanese heading must use a CJK-capable platform font,
        // not merely contain Japanese DOM text rendered as missing-glyph boxes.
        const japaneseText = [...fixture.marker].filter(char => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)).join('');
        const coverage = JSON.parse(execFileSync('python', ['scripts/benchmark/windows_glyphs.py', japaneseText, ...fonts.map(font => font.familyName)], { encoding: 'utf8' }));
        fonts = fonts.map((font, index) => ({ ...font, coverage: coverage[index] }));
        const renderedJapaneseGlyphs = fonts.filter(font => font.coverage.supported).reduce((sum, font) => sum + font.glyphCount, 0);
        if (renderedJapaneseGlyphs < japaneseText.length) {
          throw new Error(`No verified Japanese platform font: ${JSON.stringify(fonts)}`);
        }
      } finally { await session.detach(); }
      const pixels = await heading.screenshot();
      const stats = await sharp(pixels).removeAlpha().stats();
      if (Math.max(...stats.channels.map(channel => channel.stdev)) < 8) throw new Error('Heading frame is blank/uniform');
      // A screenshot is a renderer-frame witness, not a guessed sleep or window title.
      await page.screenshot({ path: imagePath });
      return { url: page.url(), fonts, heading_frame_sha256: hash(pixels), viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, userAgent: navigator.userAgent })) };
    }
    await delay(50);
  }
  throw new Error(`No visible native document body: ${fixture.marker}`);
}
async function killOwned(pid) {
  const child = owned.get(pid);
  if (!child) throw new Error('Unowned process termination refused');
  // Exact PID tree on a disposable runner. Never kill by process name.
  execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' });
  const deadline = Date.now() + 10000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(20);
  if (child.exitCode === null && child.signalCode === null) throw new Error('Native process did not exit; next cold trial refused');
  owned.delete(pid);
}
async function verifyInputs() {
  for (const fixture of fixtures) if (hash(await readFile(fixture.path)) !== fixture.sha256) throw new Error('Viewing changed source bytes');
}
async function verifyNativeEditor(browser) {
  report.functional = [];
  for (const fixture of fixtures) {
    const marker = `${fixture.marker}-savecheck`;
    const source = (await readFile(fixture.path, 'utf8')).replace(fixture.marker, marker);
    const path = `${fixture.path}.savecheck.md`;
    await writeFile(path, source, { flag: 'wx' });
    launch({ path });
    await observe(browser, { marker }, join(out, 'functional-frame.png'));
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://tauri.localhost') || page.url().startsWith('https://tauri.localhost'));
    if (!page) throw new Error('Native application page unavailable for functional check');
    await page.getByRole('button', { name: 'Isolated read-only preview', exact: true }).click();
    const body = page.frameLocator('iframe[title="Isolated document preview"]').locator('body');
    await body.getByRole('heading', { name: marker, exact: true }).waitFor({ state: 'visible' });
    const boundary = await body.evaluate(async () => {
      let parentBlocked = false;
      try { void parent.document; } catch { parentBlocked = true; }
      const violation = new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 2000);
        document.addEventListener('securitypolicyviolation', event => {
          if (event.violatedDirective === 'connect-src') { clearTimeout(timer); resolve(true); }
        }, { once: true });
      });
      await fetch('https://example.invalid/native-csp-probe').catch(() => {});
      return { parentBlocked, networkPolicyBlocked: await violation, tauri: '__TAURI_INTERNALS__' in window || '__TAURI__' in window, scripts: document.scripts.length };
    });
    if (!boundary.parentBlocked || !boundary.networkPolicyBlocked || boundary.tauri || boundary.scripts !== 0) throw new Error(`Native isolated boundary failed: ${JSON.stringify(boundary)}`);
    if (!Buffer.from(source).equals(await readFile(path))) throw new Error('Native preview changed source bytes');
    await page.getByRole('button', { name: 'Return to editor', exact: true }).click();
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    const editor = page.locator('.code-editor .cm-content');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('追記😀');
    await page.keyboard.press('Control+s');
    const expected = Buffer.from(source + '追記😀');
    const deadline = Date.now() + 10000;
    let saved = false;
    while (Date.now() < deadline) {
      if (expected.equals(await readFile(path))) { saved = true; break; }
      await delay(50);
    }
    if (!saved) throw new Error(`Native Source save changed BOM/newlines or did not complete: ${marker}`);
    report.functional.push({ fixture: fixture.sha256, boundary, source_save_sha256: hash(expected), status: 'passed' });
    await page.getByRole('button', { name: 'Visual', exact: true }).click();
    await verifyInputs();
  }
  console.log(JSON.stringify({ app: appName, native_functional: report.functional }));
}
try {
  let child, browser;
  for (let index = 0; index < 30; index++) {
    const fixture = fixtures[index % fixtures.length];
    currentTrial = { mode: 'cold-process', index, fixture: fixture.sha256 };
    const begin = process.hrtime.bigint();
    child = launch(fixture);
    const stopMemory = await watchMemory(child.pid, `cold-${index}`);
    browser = await connect();
    const view = await observe(browser, fixture, join(out, 'latest-frame.png'));
    const observed_ms = Number(process.hrtime.bigint() - begin) / 1e6;
    const memory = await stopMemory();
    trials.push({ mode: 'cold-process', index, fixture: fixture.sha256, observed_ms, memory, view, status: 'success' });
    currentTrial = null;
    await browser.close();
    await killOwned(child.pid);
    await verifyInputs();
    await writeFile(join(out, 'native-results.json'), JSON.stringify(report, null, 2));
  }
  child = launch(fixtures[0]);
  browser = await connect();
  await observe(browser, fixtures[0], join(out, 'latest-frame.png'));
  for (let index = 0; index < 50; index++) {
    // Alternate distinct documents so an already-visible frame cannot pass.
    const fixture = fixtures[(index + 1) % fixtures.length];
    currentTrial = { mode: 'warm', index, fixture: fixture.sha256 };
    const stopMemory = await watchMemory(child.pid, `warm-${index}`);
    const begin = process.hrtime.bigint();
    launch(fixture);
    const view = await observe(browser, fixture, join(out, 'latest-frame.png'));
    const observed_ms = Number(process.hrtime.bigint() - begin) / 1e6;
    const memory = await stopMemory();
    trials.push({ mode: 'warm', index, fixture: fixture.sha256, observed_ms, memory, view, status: 'success' });
    currentTrial = null;
    await verifyInputs();
    await writeFile(join(out, 'native-results.json'), JSON.stringify(report, null, 2));
  }
  if (functionalFlag === '--verify-editor') await verifyNativeEditor(browser);
  await browser.close();
  await killOwned(child.pid);
  report.status = 'passed';
} catch (error) {
  if (currentTrial) trials.push({ ...currentTrial, status: 'failed', error: String(error) });
  report.status = 'failed'; report.error = String(error);
  process.exitCode = 1;
} finally {
  for (const pid of [...owned.keys()]) {
    try { if (owned.has(pid)) await killOwned(pid); }
    catch (error) { report.status = 'failed'; report.cleanup_error = String(error); process.exitCode = 1; }
  }
  await writeFile(join(out, 'native-results.json'), JSON.stringify(report, null, 2));
  report.summary = summarizeNative(trials);
  await writeFile(join(out, 'native-summary.json'), JSON.stringify({ app: appName, environment: report.environment, status: report.status, summary: report.summary }, null, 2));
  console.log(JSON.stringify({ app: appName, environment: report.environment, diagnostic_summary: report.summary }));
  console.log(JSON.stringify({ app: appName, status: report.status, completed_trials: trials.length, error: report.error }));
}
