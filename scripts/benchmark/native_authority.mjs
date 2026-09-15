// Exercise the packaged application's real IPC after all timed trials finish.
// The caller owns the disposable process and handles its eventual termination.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const digest = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const invoke = (page, command, args = {}) => page.evaluate(
  ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
  { command, args },
);

async function findWindow(browser, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      const actual = await invoke(page, 'get_current_window_label').catch(() => null);
      if (actual === label) return page;
    }
    await delay(100);
  }
  throw new Error(`Native editor IPC did not become ready: ${label}`);
}

async function denied(page, args) {
  await assert.rejects(() => invoke(page, 'native_read_grant', args), error => {
    assert.equal(error?.code, 'permission_required');
    return true;
  });
}

export async function exerciseNativeAuthority(browser, fixture, unselectedPath) {
  const source = await findWindow(browser, 'main');
  const original = await invoke(source, 'native_get_grant', { path: fixture.path });
  assert.ok(original?.read, 'OS ingress must grant the owning editor READ');
  const readArgs = { id: original.id, relative: '', limit: 1024 * 1024 };
  assert.equal(digest(await invoke(source, 'native_read_grant', readArgs)), fixture.sha256);
  assert.equal(await invoke(source, 'native_get_grant', { path: unselectedPath }), null);
  await denied(source, { ...readArgs, id: '00000000-0000-4000-8000-000000000000' });

  const targetLabel = await invoke(source, 'create_new_window', { filePath: null });
  assert.notEqual(targetLabel, 'main');
  const target = await findWindow(browser, targetLabel);
  // Renderer-supplied labels and metadata cannot manufacture ownership.
  assert.equal(await invoke(target, 'native_get_grant', { path: fixture.path, windowLabel: 'main' }), null);
  await denied(target, { ...readArgs, windowLabel: 'main', sourceWindow: 'main' });
  await invoke(target, 'register_open_file', { filePath: unselectedPath, windowLabel: 'main' });
  assert.equal(await invoke(target, 'native_get_grant', { path: unselectedPath }), null);
  assert.equal(await invoke(target, 'check_file_open', { filePath: unselectedPath }), targetLabel);
  await invoke(target, 'unregister_open_file', { filePath: unselectedPath });

  // The existing target must load a real tab and ACK before this resolves.
  await invoke(source, 'transfer_tab_to_window', {
    filePath: fixture.path, sourceWindow: 'window-4294967295', targetWindow: targetLabel,
  });
  const transferred = await invoke(target, 'native_get_grant', { path: fixture.path });
  assert.ok(transferred?.read);
  assert.notEqual(transferred.id, original.id);
  assert.equal(transferred.write, original.write);
  assert.equal(digest(await invoke(target, 'native_read_grant', { ...readArgs, id: transferred.id })), fixture.sha256);
  assert.equal(digest(await invoke(source, 'native_read_grant', readArgs)), fixture.sha256);
  assert.deepEqual(await invoke(target, 'native_get_pending_transfers'), []);

  // A new target must register its startup consumer before ACKing the transfer.
  const startupLabel = await invoke(source, 'create_new_window', { filePath: fixture.path });
  const startup = await findWindow(browser, startupLabel);
  const started = await invoke(startup, 'native_get_grant', { path: fixture.path });
  assert.ok(started?.read);
  assert.notEqual(started.id, original.id);
  assert.equal(digest(await invoke(startup, 'native_read_grant', { ...readArgs, id: started.id })), fixture.sha256);
  assert.deepEqual(await invoke(startup, 'native_get_pending_transfers'), []);
  assert.equal(await invoke(source, 'check_file_open', { filePath: fixture.path }), 'main');
  return {
    status: 'passed', source: 'main', target: targetLabel, startup_target: startupLabel,
    fixture_sha256: fixture.sha256,
    checks: ['owned read', 'unselected path denied', 'unknown grant denied',
      'foreign caller and spoofed label denied', 'metadata grants no authority',
      'existing target ACK', 'source authority retained', 'new target startup ACK'],
  };
}
