// Real release-process T05 observations, outside all timed benchmark trials.
// Never drains the queue itself, patches the renderer, or opens a source editor.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DEADLINE_MS = 45_000;
const MAX_FIXTURE_BYTES = 64 * 1024;
const BOOTSTRAP_NAMES = new Set(['document', 'dokument', '文档']); // newDocument translations
export const hashBytes = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

export function queueFixtures(root, paths = path) {
  assert.ok(paths.isAbsolute(root), 'Fixture root must be absolute');
  assert.ok(root.length < 1024, 'Fixture root path is unexpectedly large');
  const result = [];
  for (const batch of ['cold', 'warm', 'promoted']) {
    for (let index = 0; index < 3; index++) {
      const name = `${batch}-${index}-日本語 ${index === 1 ? 'literal%20' : 'document'}.md`;
      let parent = paths.join(root, batch);
      if (index === 2) while (paths.join(parent, name).length < 320) {
        parent = paths.join(parent, 'long-日本語-0123456789');
      }
      const newline = index === 0 ? '\n' : '\r\n';
      const marker = `MDW-QUEUE-${batch}-${index}-日本語`;
      const text = (index === 2 ? '\uFEFF' : '') + [
        `# ${marker}`, '', '原文保持の合成テスト。', '',
        ':::unknown untouched  ', '', 'MDW-END-本文末尾', '', '',
      ].join(newline);
      const bytes = Buffer.from(text);
      result.push({ batch, name, marker, path: paths.join(parent, name), bytes, sha256: hashBytes(bytes) });
    }
  }
  const bytes = Buffer.from('Unselected synthetic sentinel.\r\n');
  result.push({ batch: 'sentinel', name: 'unselected.md', path: paths.join(root, 'unselected.md'), bytes, sha256: hashBytes(bytes) });
  assert.ok(result.length <= 12 && result.reduce((sum, entry) => sum + entry.bytes.length, 0) <= MAX_FIXTURE_BYTES);
  return result;
}

export async function verifyQueueBytes(fixtures, stage, result) {
  const hashes = [];
  result.byte_checks ??= [];
  result.byte_checks.push({ stage, hashes });
  let failed = false;
  for (const fixture of fixtures) {
    try {
      const actual = hashBytes(await readFile(fixture.path));
      hashes.push({ path: fixture.path, sha256: actual, unchanged: actual === fixture.sha256 });
      if (actual !== fixture.sha256) failed = true;
    } catch (error) { hashes.push({ path: fixture.path, error: String(error) }); failed = true; }
  }
  assert.equal(failed, false, `Source bytes changed or became unreadable at ${stage}`);
}

export function assertTabs(snapshot, expectedNames, activeName = expectedNames.at(-1)) {
  const names = snapshot.map(tab => tab.name);
  const expected = new Set(expectedNames);
  assert.deepEqual(names.filter(name => expected.has(name)), expectedNames, 'Fixture tab order/count changed');
  const other = names.filter(name => !expected.has(name));
  assert.ok(other.length <= 1 && other.every(name => BOOTSTRAP_NAMES.has(name)), 'Unexpected non-fixture file tab');
  assert.ok(snapshot.every(tab => !tab.dirty), 'Viewing produced an unsaved edit');
  if (activeName !== undefined) {
    assert.deepEqual(snapshot.filter(tab => tab.active).map(tab => tab.name), [activeName], 'Wrong active document');
  }
}

export function assertFocus(snapshot, owner, other) {
  assert.equal(snapshot.owner.label, owner);
  assert.equal(snapshot.other.label, other);
  assert.equal(snapshot.owner.focused, true, 'Native owner did not receive focus');
  assert.equal(snapshot.owner.minimized, false, 'Native owner remains minimized');
  assert.equal(snapshot.owner.visible, true, 'Native owner is not visible');
  assert.equal(snapshot.other.focused, false, 'Wrong sibling still owns focus');
}

async function bounded(label, action) {
  let timer;
  try {
    return await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: operation deadline`)), DEADLINE_MS);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(label, observe, ready) {
  const deadline = Date.now() + DEADLINE_MS;
  let last;
  do {
    last = await observe();
    if (ready(last)) return last;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}: readiness deadline; last=${JSON.stringify(last)?.slice(0, 3000)}`);
}
const invoke = (page, command, args = {}) => bounded(command, () => page.evaluate(
  ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args },
));
const windowCommand = (page, command, label) => invoke(page, `plugin:window|${command}`, { label });
const tabs = page => bounded('tab snapshot', () => page.locator('.tab-bar .tab').evaluateAll(elements => elements.map(tab => ({
  name: tab.querySelector('.tab-name')?.textContent ?? '',
  active: tab.classList.contains('active'), dirty: !!tab.querySelector('.tab-unsaved'),
}))));
async function findWindow(browser, label) {
  let match;
  await until(`editor ${label}`, async () => {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      if (await invoke(page, 'get_current_window_label').catch(() => null) === label) { match = page; return true; }
    }
    return false;
  }, Boolean);
  return match;
}
async function windowState(page, label) {
  return { label, focused: await windowCommand(page, 'is_focused', label),
    minimized: await windowCommand(page, 'is_minimized', label), visible: await windowCommand(page, 'is_visible', label) };
}
async function focusEvidence(ownerPage, owner, otherPage, other) {
  return until('native focus', async () => ({ owner: await windowState(ownerPage, owner), other: await windowState(otherPage, other) }), value => {
    try { assertFocus(value, owner, other); return true; } catch { return false; }
  });
}
async function deniedGrant(page, id) {
  const result = await bounded('foreign grant denial', () => page.evaluate(async id => {
    try { await window.__TAURI_INTERNALS__.invoke('native_read_grant', { id, relative: '', limit: 64 * 1024 }); return { ok: true }; }
    catch (error) { return { ok: false, code: error?.code ?? null }; }
  }, id));
  assert.deepEqual(result, { ok: false, code: 'permission_required' });
}

export async function exerciseNativeOpenQueue({ out, launchPaths, connect, killOwned, observe, result }) {
  assert.equal(process.platform, 'win32', 'Native queue probe requires Windows');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  const fixtureRoot = path.join(out, 'open-queue');
  const fixtures = queueFixtures(fixtureRoot);
  const batches = Object.fromEntries(['cold', 'warm', 'promoted'].map(batch => [batch, fixtures.filter(f => f.batch === batch)]));
  const sentinel = fixtures.at(-1);
  Object.assign(result, { schema: 1, status: 'running', phase: 'fixture-setup', phases: [], fixtures: [],
    limitations: ['Release executable via argv; shell associations not exercised or changed.',
      'Process cold, not reboot/cache cold. Windows CDP diagnostic; no macOS/Linux acceptance.',
      'Promotion is tested before a subsequent batch, not destruction during an undrained batch.',
      'Post-getter/pre-open loss remains unsupported by the non-acknowledged native open queue.',
      'Focus is observed via real native window state, without OS foreground correction after ingress.'] });
  const persist = () => writeFile(path.join(out, 'native-open-queue.json'), JSON.stringify(result, null, 2));
  const created = [];
  const verify = stage => verifyQueueBytes(created, stage, result);
  const children = [];
  const launch = paths => { const process = launchPaths(paths); children.push(process); return process; };
  let browser, child;
  const pages = new Map();
  const record = async (phase, evidence) => {
    await verify(phase);
    result.phases.push({ phase, status: 'passed', ...evidence });
    await persist();
  };
  const assertAlive = () => assert.ok(child && child.exitCode === null && child.signalCode === null, 'Original process exited unexpectedly');
  const minimizeOwned = async (page, label) => {
    assertAlive();
    const previousTitle = await windowCommand(page, 'title', label);
    const marker = `MDW-QUEUE-${child.pid}-${label}`;
    await invoke(page, 'plugin:window|set_title', { label, value: marker });
    try {
      // Test-only OS setup; the product deliberately has no minimize IPC grant.
      // Exact PID + unique native title identify only this probe's target HWND.
      const evidence = JSON.parse(execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-File', 'scripts/benchmark/windows_queue_state.ps1',
        '-OwnedProcessId', String(child.pid), '-ExactTitle', marker,
      ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 }));
      assert.equal(evidence.pid, child.pid);
      assert.equal(evidence.title, marker);
      assert.equal(evidence.minimized, true);
      result.minimize_setup ??= [];
      result.minimize_setup.push({ label, ...evidence });
    } finally {
      await invoke(page, 'plugin:window|set_title', { label, value: previousTitle });
    }
  };
  const forwarding = async batch => {
    const forwarded = launch(batch.map(f => f.path));
    assert.notEqual(forwarded.pid, child.pid);
    await until('second-instance exit', async () => ({ code: forwarded.exitCode, signal: forwarded.signalCode }), value => value.code !== null || value.signal !== null);
    assert.equal(forwarded.exitCode, 0, 'Forwarding process failed');
    assertAlive();
    return forwarded.pid;
  };
  const checkBatch = async (page, expected, active = expected.at(-1)) => {
    const snapshot = await until('ordered document tabs', () => tabs(page), value => {
      try { assertTabs(value, expected.map(f => f.name), active.name); return true; } catch { return false; }
    });
    const grants = [];
    for (const fixture of expected) {
      const grant = await invoke(page, 'native_get_grant', { path: fixture.path });
      assert.ok(grant?.read && grant.kind === 'document', 'Native ingress document READ missing');
      const bytes = await invoke(page, 'native_read_grant', { id: grant.id, relative: '', limit: MAX_FIXTURE_BYTES });
      assert.equal(hashBytes(bytes), fixture.sha256, `Wrong authorized bytes: ${fixture.name}`);
      grants.push({ path: fixture.path, id: grant.id, sha256: hashBytes(bytes) });
    }
    assert.equal(await invoke(page, 'native_get_grant', { path: sentinel.path }), null);
    return { tabs: snapshot, grants };
  };
  const checkAbsent = async (page, entries) => {
    for (const fixture of entries) assert.equal(await invoke(page, 'native_get_grant', { path: fixture.path }), null, 'Sibling unexpectedly acquired READ');
  };
  const showBody = (fixture, suffix) => observe(browser, fixture, path.join(out, `queue-${suffix}.png`));
  const showBodies = async (page, batch, prefix) => {
    const views = [];
    for (const fixture of batch) {
      await page.locator('.tab-bar .tab').filter({ has: page.locator('.tab-name', { hasText: fixture.name }) }).click({ timeout: DEADLINE_MS });
      views.push({ path: fixture.path, view: await showBody(fixture, `${prefix}-${batch.indexOf(fixture)}`) });
    }
    return views;
  };
  try {
    await persist();
    await mkdir(fixtureRoot, { recursive: false });
    for (const fixture of fixtures) {
      await mkdir(path.dirname(fixture.path), { recursive: true });
      await writeFile(fixture.path, fixture.bytes, { flag: 'wx' });
      created.push(fixture);
      result.fixtures.push({ path: fixture.path, batch: fixture.batch, utf16_path_length: fixture.path.length,
        bytes: fixture.bytes.length, sha256: fixture.sha256 });
    }
    await persist();
    result.phase = 'cold-multiple';
    const cold = batches.cold;
    child = launch([cold[0].path, cold[1].path, cold[0].path, cold[2].path]);
    result.pid = child.pid;
    browser = await connect();
    const main = await findWindow(browser, 'main'); pages.set('main', main);
    const initial = await checkBatch(main, cold);
    const view = await showBody(cold.at(-1), 'cold-last');
    // Every inactive document must actually display when its existing tab is selected.
    const coldViews = await showBodies(main, cold, 'cold');
    await record(result.phase, { ...initial, view, views: coldViews });

    result.phase = 'secondary-setup';
    const labels = [await invoke(main, 'create_new_window', { filePath: null }), await invoke(main, 'create_new_window', { filePath: null })];
    assert.ok(labels.every(label => /^window-[1-9]\d*$/.test(label)) && new Set(labels).size === 2);
    labels.sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
    const [lowLabel, highLabel] = labels;
    const low = await findWindow(browser, lowLabel), high = await findWindow(browser, highLabel);
    pages.set(lowLabel, low); pages.set(highLabel, high);
    await checkAbsent(low, [...cold, ...batches.warm, ...batches.promoted]);
    await checkAbsent(high, [...cold, ...batches.warm, ...batches.promoted]);
    assertTabs(await tabs(low), []); assertTabs(await tabs(high), []);
    const allLabels = ['main', ...labels].sort();
    assert.deepEqual((await invoke(main, 'get_all_windows')).sort(), allLabels);
    await record(result.phase, { labels });

    result.phase = 'warm-multiple';
    await minimizeOwned(main, 'main');
    await until('main minimized', () => windowCommand(main, 'is_minimized', 'main'), Boolean);
    await windowCommand(high, 'set_focus', highLabel);
    await until('sibling initial focus', () => windowCommand(high, 'is_focused', highLabel), Boolean);
    const beforeWarm = { main: await windowState(main, 'main'), sibling: await windowState(high, highLabel) };
    result.transition = { phase: result.phase, before: beforeWarm }; await persist();
    const warmPid = await forwarding(batches.warm);
    // Observe focus BEFORE any tab click or render helper can affect activation.
    const warmFocus = await focusEvidence(main, 'main', high, highLabel);
    const warm = await checkBatch(main, [...cold, ...batches.warm]);
    await checkAbsent(low, batches.warm); await checkAbsent(high, batches.warm);
    assertTabs(await tabs(low), []); assertTabs(await tabs(high), []);
    assert.deepEqual((await invoke(main, 'get_all_windows')).sort(), allLabels);
    await record(result.phase, { ...warm, forwarded_pid: warmPid, before: beforeWarm, focus: warmFocus, view: await showBody(batches.warm.at(-1), 'warm-last'), views: await showBodies(main, batches.warm, 'warm') });

    result.phase = 'main-close';
    // Normal close request, allowing the application's own clean/dirty guard to run.
    // Its reply can race page destruction: confirm both page and host registry below.
    await windowCommand(main, 'close', 'main').catch(error => { result.close_reply_error = String(error).slice(0, 1000); });
    await until('main destroyed', async () => ({ closed: main.isClosed(), labels: (await invoke(low, 'get_all_windows')).sort() }), value => value.closed && JSON.stringify(value.labels) === JSON.stringify([...labels].sort()));
    assertAlive();
    for (const grant of initial.grants) await deniedGrant(low, grant.id);
    await record(result.phase, { surviving_labels: labels });

    result.phase = 'promoted-multiple';
    await checkAbsent(low, batches.promoted); await checkAbsent(high, batches.promoted);
    await minimizeOwned(low, lowLabel);
    await until('promoted owner minimized', () => windowCommand(low, 'is_minimized', lowLabel), Boolean);
    await windowCommand(high, 'set_focus', highLabel);
    await until('sibling initial focus', () => windowCommand(high, 'is_focused', highLabel), Boolean);
    const beforePromotion = { owner: await windowState(low, lowLabel), sibling: await windowState(high, highLabel) };
    result.transition = { phase: result.phase, before: beforePromotion }; await persist();
    const promotedPid = await forwarding(batches.promoted);
    const promotedFocus = await focusEvidence(low, lowLabel, high, highLabel);
    const promoted = await checkBatch(low, batches.promoted);
    await checkAbsent(high, batches.promoted);
    assertTabs(await tabs(high), []);
    assert.deepEqual((await invoke(low, 'get_all_windows')).sort(), [...labels].sort());
    await record(result.phase, { ...promoted, owner: lowLabel, forwarded_pid: promotedPid, before: beforePromotion, focus: promotedFocus, view: await showBody(batches.promoted.at(-1), 'promoted-last'), views: await showBodies(low, batches.promoted, 'promoted') });

    result.phase = 'repeat-focus';
    await windowCommand(high, 'set_focus', highLabel);
    await until('repeat baseline focus', () => windowCommand(high, 'is_focused', highLabel), Boolean);
    const repeated = batches.promoted[0];
    const repeatPid = await forwarding([repeated]);
    const repeatedFocus = await focusEvidence(low, lowLabel, high, highLabel);
    const repeat = await checkBatch(low, batches.promoted, repeated);
    await record(result.phase, { ...repeat, forwarded_pid: repeatPid, focus: repeatedFocus, view: await showBody(repeated, 'repeat') });
    assertAlive();
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = String(error);
    for (const [label, page] of pages) if (!page.isClosed()) {
      try {
        result.failure_windows ??= [];
        result.failure_windows.push({ label, tabs: await tabs(page), native: await windowState(page, label) });
        await page.screenshot({ path: path.join(out, `queue-failure-${label}.png`), timeout: 5000 });
      } catch (diagnostic) { result.diagnostic_error = String(diagnostic).slice(0, 1000); }
    }
    throw error;
  } finally {
    const finish = async (name, action) => {
      try { await action(); }
      catch (error) { result.status = 'failed'; result[name] = String(error); }
    };
    await finish('before_cleanup_hash_error', () => verify('before-cleanup'));
    if (browser) await finish('cdp_cleanup_error', () => bounded('disconnect CDP', () => browser.close()));
    for (const process of [...children].reverse()) if (process.exitCode === null && process.signalCode === null) {
      await finish(`process_${process.pid}_cleanup_error`, () => killOwned(process.pid));
    }
    await finish('after_cleanup_hash_error', () => verify('after-cleanup'));
    await persist();
  }
  assert.equal(result.status, 'passed', 'Queue probe cleanup or byte verification failed');
  return result;
}
