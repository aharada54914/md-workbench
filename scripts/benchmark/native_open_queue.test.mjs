import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { queueFixtures, assertTabs, assertFocus, hashBytes, verifyQueueBytes } from './native_open_queue.mjs';

const tab = (name, active = false, dirty = false) => ({ name, active, dirty });

test('Windows fixtures exercise actual Unicode/space/percent and long paths in each disjoint batch', () => {
  const root = String.raw`C:\runner\native-fork\open-queue`;
  const fixtures = queueFixtures(root, path.win32);
  assert.equal(fixtures.length, 10);
  assert.equal(new Set(fixtures.map(f => f.path)).size, 10);
  assert.equal(new Set(fixtures.map(f => f.name)).size, 10);
  for (const batch of ['cold', 'warm', 'promoted']) {
    const group = fixtures.filter(f => f.batch === batch);
    assert.equal(group.length, 3);
    assert.ok(group.every(f => f.path.startsWith(root + '\\') && f.name.includes('日本語 ')));
    assert.ok(group[1].path.includes('literal%20'));
    assert.ok(group[2].path.length >= 320, 'Long path must exceed legacy MAX_PATH');
    assert.ok(group[2].path.split('\\').every(part => part.length < 255));
  }
  assert.ok(fixtures.reduce((total, f) => total + f.bytes.length, 0) <= 64 * 1024);
  assert.equal(fixtures.at(-1).batch, 'sentinel');
});

test('raw fixture bytes preserve LF/CRLF/BOM and significant trailing whitespace', () => {
  const fixtures = queueFixtures('/synthetic/open-queue', path.posix).slice(0, 3);
  assert.ok(!fixtures[0].bytes.includes(13));
  assert.ok(fixtures[1].bytes.includes(Buffer.from('\r\n')));
  assert.deepEqual([...fixtures[2].bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  for (const fixture of fixtures) {
    assert.ok(fixture.bytes.toString('utf8').includes(':::unknown untouched  '));
    assert.equal(hashBytes(new Uint8Array(fixture.bytes)), fixture.sha256);
    assert.notEqual(hashBytes(Buffer.concat([fixture.bytes, Buffer.from(' ')])), fixture.sha256);
  }
  assert.throws(() => queueFixtures('relative', path.posix), /absolute/);
});

test('tab witness accepts retained bootstrap only and requires exact fixture order, count, activity and clean state', () => {
  const names = ['first.md', 'second.md', 'third.md'];
  const correct = [tab('document'), tab(names[0]), tab(names[1]), tab(names[2], true)];
  assert.doesNotThrow(() => assertTabs(correct, names));
  for (const snapshot of [
    [correct[0], correct[2], correct[1], correct[3]],
    [...correct, tab(names[0])],
    correct.slice(0, 3),
    [...correct, tab('unselected.md')],
    [tab('document'), tab('document'), ...correct.slice(1)],
    [tab(names[0], true), tab(names[1]), tab(names[2])],
    [tab(names[0], false, true), tab(names[1]), tab(names[2], true)],
  ]) assert.throws(() => assertTabs(snapshot, names));
  assert.doesNotThrow(() => assertTabs([tab(names[0], true), tab(names[1]), tab(names[2])], names, names[0]));
});

test('native focus evidence refuses wrong labels, sibling focus, hidden or minimized owner', () => {
  const make = () => ({ owner: { label: 'window-2', focused: true, minimized: false, visible: true }, other: { label: 'window-10', focused: false, minimized: false, visible: true } });
  assert.doesNotThrow(() => assertFocus(make(), 'window-2', 'window-10'));
  for (const [side, property, value] of [
    ['owner', 'label', 'main'], ['other', 'label', 'window-1'],
    ['owner', 'focused', false], ['other', 'focused', true],
    ['owner', 'minimized', true], ['owner', 'visible', false],
  ]) {
    const snapshot = make(); snapshot[side][property] = value;
    assert.throws(() => assertFocus(snapshot, 'window-2', 'window-10'));
  }
});


test('input hash checks retain all actual hashes on corruption/deletion and never rewrite source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mdw-queue-hash-'));
  try {
    const entries = [0, 1, 2].map(index => ({ path: path.join(root, `${index}.md`), sha256: hashBytes('original') }));
    for (const entry of entries) await writeFile(entry.path, 'original', { flag: 'wx' });
    const result = {};
    await verifyQueueBytes(entries, 'before', result);
    assert.ok(result.byte_checks[0].hashes.every(entry => entry.unchanged));
    await writeFile(entries[0].path, 'changed');
    await rm(entries[1].path);
    await assert.rejects(verifyQueueBytes(entries, 'after', result), /Source bytes changed/);
    const actual = result.byte_checks[1].hashes;
    assert.equal(actual.length, 3);
    assert.equal(actual[0].sha256, hashBytes('changed'));
    assert.equal(actual[0].unchanged, false);
    assert.match(actual[1].error, /ENOENT/);
    assert.equal(actual[2].unchanged, true);
    const recheck = {};
    await assert.rejects(verifyQueueBytes(entries, 'again', recheck));
    assert.equal(recheck.byte_checks[0].hashes[0].sha256, hashBytes('changed'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
