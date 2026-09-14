import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarizeNative } from './native_summary.mjs';

test('type-7 percentiles and empty observations', () => {
  assert.equal(percentile([40, 10, 30, 20], .5), 25);
  assert.equal(percentile([40, 10, 30, 20], .95), 38.5);
  assert.equal(percentile([], .5), null);
});

test('separates modes and fixture hashes, retains failures and missing memory', () => {
  const groups = summarizeNative([
    { mode: 'warm', fixture: 'a', status: 'success', observed_ms: 10 },
    { mode: 'warm', fixture: 'a', status: 'failed', observed_ms: 0 },
    { mode: 'warm', fixture: 'b', status: 'success', observed_ms: 40 },
    { mode: 'cold-process', fixture: 'a', status: 'success', observed_ms: 90 },
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].successful, 1);
  assert.equal(groups[0].failed, 1);
  assert.equal(groups[0].observed_ms.p50, 10);
  assert.equal(groups[0].memory.private_bytes.p50, null);
  assert.equal(groups[0].production_benchmark_eligible, false);
  assert.equal(groups[0].required_samples, 50);
});
