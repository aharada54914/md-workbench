import test from 'node:test';
import assert from 'node:assert/strict';
import { commands, nativeDenialCounts, observeNativeDenials } from './native-receipts.mjs';

const receipts = () => commands.map(command => `MDW_DIAGRAM_IPC_DENIED ${JSON.stringify({ command })}\n`).join('');
const waitFor = async predicate => { if (!predicate()) throw Error('Observation timeout'); };

test('wrapper receipts cannot satisfy child observation; missing child remains unsupported', async () => {
  let log = '';
  const order = [];
  const result = await observeNativeDenials({
    contexts: [
      { name: 'wrapper', send: async () => { order.push('wrapper'); log += receipts(); return 'sent'; } },
      { name: 'child', send: async () => { order.push('child'); return 'sent'; } },
    ], readLog: () => log, waitFor,
  });
  assert.deepEqual(order, ['wrapper', 'child']);
  assert.equal(result.wrapper.status, 'passed');
  assert.equal(result.child.status, 'unsupported');
  assert.deepEqual(Object.values(result.child.receipts), [0, 0, 0, 0]);
  assert.equal(result.child.reason, 'no_native_receipt');
});

test('each context requires one receipt for every command from its own observation interval', async () => {
  let log = receipts(); // Earlier receipts are never credited.
  const result = await observeNativeDenials({
    contexts: ['wrapper', 'child'].map(name => ({ name, send: async () => { log += receipts(); return 'sent'; } })),
    readLog: () => log, waitFor,
  });
  assert.deepEqual(Object.values(result).map(value => value.status), ['passed', 'passed']);
  assert.deepEqual(Object.values(result.child.receipts), [1, 1, 1, 1]);
});

test('partial or duplicate delivery fails instead of becoming a successful subset', async () => {
  for (const delivered of [receipts().split('\n')[0] + '\n', receipts() + receipts()]) {
    let log = '';
    const result = await observeNativeDenials({
      contexts: [{ name: 'child', send: async () => { log = delivered; return 'sent'; } }],
      readLog: () => log, waitFor,
    });
    assert.equal(result.child.status, 'failed');
    assert.equal(result.child.reason, 'unexpected_native_receipt_counts');
  }
});

test('an incomplete earlier context makes later receipt attribution unconfirmed', async () => {
  let log = '';
  const result = await observeNativeDenials({
    contexts: [
      { name: 'wrapper', send: async () => 'sent' },
      { name: 'child', send: async () => { log += receipts(); return 'sent'; } },
    ], readLog: () => log, waitFor,
  });
  assert.equal(result.child.status, 'failed');
  assert.equal(result.child.reason, 'prior_context_unconfirmed');
});

test('missing transport and thrown dispatch are separate from native rejection and do not stop later contexts', async () => {
  const result = await observeNativeDenials({
    contexts: [
      { name: 'wrapper', send: async () => 'unavailable' },
      { name: 'child', send: async () => { throw Error('do not serialize arbitrary payload'); } },
    ], readLog: () => '', waitFor,
  });
  assert.equal(result.wrapper.reason, 'transport_unavailable');
  assert.equal(result.child.reason, 'dispatch_failed');
  assert.doesNotMatch(JSON.stringify(result), /arbitrary payload/);
});

test('receipt parsing accepts only complete allowlisted constant-command records', () => {
  const log = receipts() + 'unrelated stderr\nMDW_DIAGRAM_IPC_DENIED {"command":"secret"}\nMDW_DIAGRAM_IPC_DENIED {"command":"native_read_path","extra":"no"}\nMDW_DIAGRAM_IPC_DENIED {"command":"native_read_path"}';
  assert.deepEqual(Object.values(nativeDenialCounts(log)), [1, 1, 1, 1]);
});
