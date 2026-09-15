// Adversarial debugger probes of the real packaged preview. Debugger evaluation
// can run despite sandbox script restrictions; it is not document script execution.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const observationMs = 5000;
const pollMs = 100;

// Start in the inspected frame, but own the deadline in Node. Awaiting a fetch
// inside evaluate would otherwise hang indefinitely on a broken transport.
async function startFetch(target, ipcUrl, packet, token, tag) {
  await target.evaluate(({ ipcUrl, packet, token, tag }) => {
    window.__mdwBoundaryFetch ??= {};
    window.__mdwBoundaryFetch[token] ??= {};
    const probe = { state: 'pending', controller: new AbortController() };
    window.__mdwBoundaryFetch[token][tag] = probe;
    void fetch(ipcUrl, {
      method: 'POST', body: JSON.stringify(packet.payload), signal: probe.controller.signal,
      headers: { 'Content-Type': 'application/json', 'Tauri-Invoke-Key': packet.__TAURI_INVOKE_KEY__,
        'Tauri-Callback': String(packet.callback), 'Tauri-Error': String(packet.error) },
    }).then(response => {
      probe.state = 'resolved';
      probe.response = response.headers.get('Tauri-Response');
      probe.status = response.status;
      return response.body?.cancel();
    }, error => {
      probe.state = 'rejected';
      probe.error = String(error?.name ?? 'Error');
    }).catch(() => { /* Body cancellation is cleanup, not an IPC result. */ });
  }, { ipcUrl, packet, token, tag });
}

const fetchState = (target, token, tag) => target.evaluate(({ token, tag }) => {
  const { state, response, status, error } = window.__mdwBoundaryFetch[token][tag];
  return { state, response, status, error };
}, { token, tag });

async function waitForFetch(target, token, tag) {
  const deadline = Date.now() + observationMs;
  do {
    const result = await fetchState(target, token, tag);
    if (result.state !== 'pending') return result;
    await delay(pollMs);
  } while (Date.now() < deadline);
  throw new Error(`${tag} fetch did not settle within ${observationMs} ms`);
}

export async function probeNativePreview(source, unselectedPath, invoke) {
  const elements = await source.locator('iframe[title="Isolated document preview"]').elementHandles();
  let frame;
  try {
    for (const element of elements) {
      if (await element.isVisible()) {
        assert.equal(await element.getAttribute('sandbox'), '');
        frame = await element.contentFrame();
        break;
      }
    }
  } finally { await Promise.all(elements.map(element => element.dispose())); }
  assert.ok(frame, 'A visible packaged isolated preview is required');
  const policy = await frame.evaluate(() => ({
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
    parentAccessible: (() => { try { return !!parent.document; } catch { return false; } })(),
  }));
  assert.equal(policy.parentAccessible, false, 'Preview must have an opaque origin');
  assert.match(policy.csp ?? '', /(?:^|;)\s*connect-src 'none'(?:;|$)/);
  assert.match(policy.csp ?? '', /(?:^|;)\s*script-src 'none'(?:;|$)/);

  // Capture only the legitimate probe call's key; restore fetch immediately.
  // The key stays in memory and must never appear in logs or returned artifacts.
  const { key, ipcUrl } = await source.evaluate(async () => {
    const ti = window.__TAURI_INTERNALS__;
    const saved = window.fetch;
    let key = null;
    const controlUrl = ti.convertFileSrc('get_current_window_label', 'ipc');
    window.fetch = function(input, init) {
      const url = input instanceof Request ? input.url : String(input);
      if (url === controlUrl) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        key = headers.get('Tauri-Invoke-Key');
      }
      return Reflect.apply(saved, this, [input, init]);
    };
    try {
      if (await ti.invoke('get_current_window_label') !== 'main') throw new Error('Wrong IPC control window');
    } finally { window.fetch = saved; }
    if (!key) throw new Error('Cannot establish genuine IPC transport control');
    return { key, ipcUrl: ti.convertFileSrc('register_open_file', 'ipc') };
  });

  const token = randomUUID();
  const paths = Object.fromEntries(['top', 'topFetch', 'frame', 'fetch']
    .map(kind => [kind, `${unselectedPath}.probe-${token}-${kind}`]));
  const callbacks = [];
  const packet = async (path, tag) => {
    const ids = await source.evaluate(({ tag, token }) => {
      const ti = window.__TAURI_INTERNALS__;
      window.__mdwBoundaryProbe ??= {};
      window.__mdwBoundaryProbe[token] ??= {};
      const result = { state: 'pending' };
      window.__mdwBoundaryProbe[token][tag] = result;
      return {
        callback: ti.transformCallback(() => { result.state = 'resolved'; }, true),
        error: ti.transformCallback(error => {
          result.state = 'rejected';
          result.error = typeof error === 'string' ? error : String(error?.message ?? 'IPC error');
          result.code = typeof error?.code === 'string' ? error.code : null;
        }, true),
      };
    }, { tag, token });
    callbacks.push(ids.callback, ids.error);
    return { cmd: 'register_open_file', payload: { filePath: path }, ...ids,
      options: { customProtocolIpcBlocked: true }, __TAURI_INVOKE_KEY__: key };
  };
  const state = tag => source.evaluate(({ token, tag }) => window.__mdwBoundaryProbe[token][tag], { token, tag });
  let failed = false;
  try {
    const positive = await packet(paths.top, 'top');
    await source.evaluate(packet => window.chrome.webview.postMessage(JSON.stringify(packet)), positive);
    const deadline = Date.now() + observationMs;
    let control = false;
    while (Date.now() < deadline) {
      if (await invoke(source, 'check_file_open', { filePath: paths.top }) === 'main' && (await state('top')).state === 'resolved') {
        control = true;
        break;
      }
      await delay(pollMs);
    }
    assert.ok(control, 'Raw native transport must pass its top-level positive control');
    await invoke(source, 'unregister_open_file', { filePath: paths.top });

    // This direct fetch has no Tauri fallback, so it independently validates the
    // URL, headers and payload used by the frame fetch probe below.
    const fetchPositive = await packet(paths.topFetch, 'topFetch');
    await startFetch(source, ipcUrl, fetchPositive, token, 'topFetch');
    const topFetch = await waitForFetch(source, token, 'topFetch');
    assert.equal(topFetch.state, 'resolved', 'Direct top-level IPC fetch must resolve');
    assert.equal(topFetch.response, 'ok', 'Direct top-level IPC fetch must succeed');
    assert.equal(await invoke(source, 'check_file_open', { filePath: paths.topFetch }), 'main');
    await invoke(source, 'unregister_open_file', { filePath: paths.topFetch });

    await frame.evaluate(token => {
      window.__mdwBoundaryDocument ??= {};
      const probe = { marker: 0, violations: [] };
      window.__mdwBoundaryDocument[token] = probe;
      probe.listener = event => probe.violations.push({
        directive: event.effectiveDirective, blockedURI: event.blockedURI,
      });
      document.addEventListener('securitypolicyviolation', probe.listener);
      // Insert a real script element: evaluate itself is debugger execution and
      // cannot establish whether ordinary document scripts are allowed.
      probe.script = document.createElement('script');
      probe.script.textContent = `window.__mdwBoundaryDocument[${JSON.stringify(token)}].marker = 1;`;
      document.body.append(probe.script);
    }, token);

    const negative = await packet(paths.frame, 'frame');
    const bridgeAttempt = await frame.evaluate(packet => {
      const bridge = window.chrome?.webview;
      if (typeof bridge?.postMessage !== 'function') return 'bridge-unavailable';
      try { bridge.postMessage(JSON.stringify(packet)); return 'sent'; }
      catch { return 'threw'; }
    }, negative);
    const fetchPacket = await packet(paths.fetch, 'fetch');
    await startFetch(frame, ipcUrl, fetchPacket, token, 'fetch');
    const fetchAttempt = await waitForFetch(frame, token, 'fetch');
    assert.equal(fetchAttempt.state, 'rejected', 'Preview fetch to native IPC must fail');
    // A pending callback alone proves nothing: responses can target the top
    // frame even when an iframe initiated the operation. Observe host state.
    const until = Date.now() + observationMs;
    do {
      await delay(pollMs);
      for (const path of [paths.frame, paths.fetch]) {
        assert.equal(await invoke(source, 'check_file_open', { filePath: path }), null,
          'Preview probe must not mutate native registry');
      }
      assert.notEqual((await state('frame')).state, 'resolved', 'Preview native command must not succeed');
      assert.notEqual((await state('fetch')).state, 'resolved', 'Preview fetch command must not succeed');
    } while (Date.now() < until);
    const documentProbe = await frame.evaluate(token => {
      const probe = window.__mdwBoundaryDocument[token];
      return { marker: probe.marker, attached: probe.script.isConnected, violations: probe.violations };
    }, token);
    assert.equal(documentProbe.attached, true, 'The real script probe must remain attached');
    assert.equal(documentProbe.marker, 0, 'Preview must not execute the inserted document script');
    const connectViolation = documentProbe.violations.some(event =>
      event.directive === 'connect-src' && [ipcUrl, new URL(ipcUrl).origin].includes(event.blockedURI));
    const frameCallback = await state('frame');
    for (const field of ['error', 'code']) {
      if (frameCallback[field]) frameCallback[field] = frameCallback[field].replaceAll(key, '[redacted]');
    }
    return {
      status: 'passed', opaque_origin: true, script_policy: 'none', connect_policy: 'none',
      raw_transport_positive_control: 'passed', iframe_bridge_attempt: bridgeAttempt,
      fetch_transport_positive_control: 'passed', iframe_fetch_attempt: fetchAttempt,
      iframe_fetch_cause: connectViolation ? 'connect-src violation observed' : 'fetch failed; cause not established',
      inline_script_probe: 'attached script did not execute',
      csp_violations: documentProbe.violations, iframe_callback: frameCallback,
      observation: `no native registry side effect observed during ${observationMs} ms`,
      limitation: 'A missing bridge or pending callback is not a Rust permission_required response. Debugger evaluation is not ordinary document script execution. Loopback network delivery is not tested here.',
    };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Attempt every cleanup even if the renderer or one registry operation fails.
    const cleanup = await Promise.allSettled([source, frame].map(target => target.evaluate(token => {
        for (const probe of Object.values(window.__mdwBoundaryFetch?.[token] ?? {})) probe.controller.abort();
        delete window.__mdwBoundaryFetch?.[token];
        const probe = window.__mdwBoundaryDocument?.[token];
        if (probe) {
          document.removeEventListener('securitypolicyviolation', probe.listener);
          probe.script.remove();
          delete window.__mdwBoundaryDocument[token];
        }
      }, token)));
    // Abort pending requests before removing their possible registry effects.
    cleanup.push(...await Promise.allSettled([
      ...Object.values(paths).map(filePath => invoke(source, 'unregister_open_file', { filePath })),
      source.evaluate(({ callbacks, token }) => {
        for (const id of callbacks) window.__TAURI_INTERNALS__.unregisterCallback(id);
        delete window.__mdwBoundaryProbe?.[token];
      }, { callbacks, token }),
    ]));
    const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (!failed && errors.length) throw new AggregateError(errors, 'Native preview probe cleanup failed');
  }
}
