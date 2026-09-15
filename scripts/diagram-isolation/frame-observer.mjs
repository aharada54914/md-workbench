import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { commands, nativeDenialCounts, observeNativeDenials } from './native-receipts.mjs';

// Only called against a fresh, owned feature-only native process.
export async function observeFrames({ fixture, main, report, until, readLog, active }) {
  const hostOrigin = 'http://mdwdiagramhost.localhost';
  const childOrigin = 'http://mdwdiagramfixture.localhost';
  const foreignOrigin = 'http://mdwdiagramforeign.localhost';
  const preflight = await until(async () => {
    const value = await fixture.evaluate(() => window.__diagramReport);
    return value?.frames?.foreign && value?.frames?.sibling ? value : null;
  });
  report.preflight = preflight;
  assert.equal(preflight.status, 'starting');
  assert.deepEqual(preflight.frames.foreign, { selectedSource:true, origin:foreignOrigin, result:'ignored' });
  assert.deepEqual(preflight.frames.sibling, { selectedSource:false, origin:childOrigin, result:'ignored' });
  const child = await until(() => fixture.frames().find(frame => frame.url() === `${childOrigin}/`));
  await until(async () => await child.evaluate(() => window.__diagramChildReport?.status) === 'awaiting_probe');
  const key = await main.evaluate(async () => {
    const saved = window.fetch; let key, timer;
    window.fetch = function(input, init) { key = new Headers(init?.headers).get('Tauri-Invoke-Key') ?? key; return Reflect.apply(saved, this, [input, init]); };
    try {
      const label = await Promise.race([window.__TAURI_INTERNALS__.invoke('get_current_window_label'), new Promise((_, reject) => { timer=setTimeout(() => reject(Error('Control timeout')), 2000); })]);
      if (label !== 'main') throw Error('Wrong main');
      return key;
    } finally { clearTimeout(timer); window.fetch = saved; }
  });
  assert.ok(key, 'Genuine native positive control required');
  report.checks.genuineNativeControl = true;
  const instrumented = await fixture.evaluate(() => {
    const bridge = window.chrome?.webview;
    if (!bridge) return false;
    const original = bridge.postMessage;
    let calls = 0;
    const observed = function(...args) { calls++; return Reflect.apply(original, this, args); };
    try { bridge.postMessage = observed; } catch { return false; }
    if (bridge.postMessage !== observed) return false;
    window.__diagramBridgeObservation = { count:() => calls, restore:() => { bridge.postMessage = original; } };
    return true;
  });
  assert.equal(instrumented, true, 'Wrapper bridge observation unavailable');
  try {
    const wrapper = await observeNativeDenials({
      contexts:[{ name:'wrapper', send:() => fixture.evaluate(({key, commands}) => {
        for (const cmd of commands) window.chrome.webview.postMessage(JSON.stringify({cmd, payload:{}, callback:1, error:2, options:{customProtocolIpcBlocked:true}, __TAURI_INVOKE_KEY__:key}));
        return 'sent';
      }, {key, commands}) }], readLog, waitFor:until,
    });
    report.nativeControl = wrapper.wrapper;
    assert.equal(wrapper.wrapper.status, 'passed');
    const wrapperBaseline = await fixture.evaluate(() => window.__diagramBridgeObservation.count());
    assert.equal(wrapperBaseline, commands.length, 'Wrapper hook positive control required');
    const before = nativeDenialCounts(readLog());
    const started = Date.now();
    report.childBridge = await child.evaluate(({key, commands}) => {
      if (!window.chrome?.webview) return 'unavailable';
      for (const cmd of commands) window.chrome.webview.postMessage(JSON.stringify({cmd, payload:{}, callback:1, error:2, options:{customProtocolIpcBlocked:true}, __TAURI_INVOKE_KEY__:key}));
      return 'sent';
    }, {key, commands});
    assert.equal(report.childBridge, 'sent');
    await delay(500);
    report.childDirectIpc = {
      observedMs:Date.now() - started,
      wrapperCalls:(await fixture.evaluate(() => window.__diagramBridgeObservation.count())) - wrapperBaseline,
      nativeReceiptDelta:Object.fromEntries(commands.map(command => [command, nativeDenialCounts(readLog())[command] - before[command]])),
    };
    assert.equal(report.childDirectIpc.wrapperCalls, 0);
    assert.ok(Object.values(report.childDirectIpc.nativeReceiptDelta).every(count => count === 0));
    // Absence during this bounded interval is evidence of this path only, not rejection.
    report.missing.push('child native IPC rejection receipt (transport dispatch observed; no native receipt in bounded interval)');
    const parentObservationStarted = Date.now();
    if (active) {
      await child.evaluate(({key, hostOrigin}) => parent.postMessage(JSON.stringify({cmd:'native_read_path', payload:{}, callback:1, error:2, __TAURI_INVOKE_KEY__:key}), hostOrigin), {key, hostOrigin});
      report.active = await until(async () => {
        const value = await fixture.evaluate(() => window.__diagramReport);
        return value?.frames?.selectedRejected ? value : null;
      });
      assert.equal(report.active.status, 'schema');
      assert.deepEqual(report.active.frames.selectedRejected, {selectedSource:true, origin:childOrigin, reason:'schema'});
    } else {
      await child.evaluate(() => window.__diagramStart());
      report.roundtrip = await until(async () => {
        const value = await fixture.evaluate(() => window.__diagramReport);
        return value?.status === 'passed_roundtrip' ? value : null;
      });
      assert.equal(report.roundtrip.childOrigin, childOrigin);
      assert.equal(report.roundtrip.candidate, true);
    }
    const terminal = await fixture.evaluate(() => window.__diagramReport);
    // After stop() removed the listener, a genuine child event cannot change it.
    await child.evaluate(({key, hostOrigin}) => parent.postMessage(JSON.stringify({cmd:'native_read_path', payload:{}, callback:1, error:2, __TAURI_INVOKE_KEY__:key}), hostOrigin), {key, hostOrigin});
    await delay(500);
    assert.deepEqual(await fixture.evaluate(() => window.__diagramReport), terminal);
    report.checks.retiredStateUnchanged = true;
    report.parentMessageObservationMs = Date.now() - parentObservationStarted;
    report.checks.parentMessageWrapperCalls = (await fixture.evaluate(() => window.__diagramBridgeObservation.count())) - wrapperBaseline;
    assert.equal(report.checks.parentMessageWrapperCalls, 0);
    assert.deepEqual(nativeDenialCounts(readLog()), before);
    report.checks.noForwardingOnObservedPaths = true;
  } finally {
    await fixture.evaluate(() => window.__diagramBridgeObservation?.restore()).catch(() => {});
  }
}
