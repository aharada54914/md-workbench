import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
export const WAR_SHA256 = '6ee1ce19242bbabf348c52e41e1fe17057d57236e731acf48d7a3710ca50c375';
export const MANIFEST_SHA256 = '1e46b33115fc440cd871ea8d6bc7ea9caeb419fd9792b6b7afc0d645e6e488ef';
export const MODES = ['baseline', 'approved-style-data', 'approved-xml-negative'];
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function validateManifest(bytes) {
  assert(bytes.length <= 600_000, 'Manifest too large');
  assert.equal(sha256(bytes), MANIFEST_SHA256, 'Fixed manifest digest mismatch');
  const m = JSON.parse(bytes.toString());
  assert.equal(m.version, '31.4.5'); assert.equal(m.warSha256, WAR_SHA256);
  assert.equal(m.files.length, 2308);
  const seen = new Set(); let total = 0;
  for (const e of m.files) {
    assert(typeof e.path === 'string' && e.path.length <= 500 && !/[\\\x00-\x1f:]/.test(e.path));
    assert(e.path.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe manifest path');
    assert(!seen.has(e.path), 'Duplicate manifest path'); seen.add(e.path);
    assert(Number.isSafeInteger(e.bytes) && e.bytes >= 0 && e.bytes <= 30_000_000);
    assert(/^[a-f0-9]{64}$/.test(e.sha256)); total += e.bytes;
  }
  assert.equal(total, 36_332_532); return m;
}
export async function readManifest() {
  const source = new URL('./manifest.json', import.meta.url);
  assert((await fs.stat(source)).size <= 600_000, 'Manifest too large');
  return validateManifest(await fs.readFile(source));
}
export async function verifyAssets(workDir, manifest) {
  const root = path.join(workDir, 'assets');
  assert(!(await fs.lstat(root)).isSymbolicLink(), 'Assets root must not be a symlink');
  for (const e of manifest.files) {
    let current = root;
    for (const segment of e.path.split('/')) {
      current = path.join(current, segment);
      assert(!(await fs.lstat(current)).isSymbolicLink(), 'Asset symlink rejected');
    }
    const stat = await fs.stat(current);
    assert(stat.isFile() && stat.size === e.bytes, `Asset size/type mismatch: ${e.path}`);
    assert.equal(sha256(await fs.readFile(current)), e.sha256, `Asset digest mismatch: ${e.path}`);
  }
}
export function parseArgs(args, allowed) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    assert(allowed.includes(key) && !Object.hasOwn(result, key) && value && !value.startsWith('--'), 'Invalid CLI arguments');
    result[key] = value;
  }
  return result;
}
export function verifyObservation(r) {
  assert.equal(r.result, 'edited-saved-exited');
  assert.deepEqual(r.events.map(e => e.event), ['init', 'load', 'save', 'exit']);
  assert(r.saved.length === 1 && r.saved[0].after && !r.saved[0].before && r.saved[0].uncompressed);
  assert.deepEqual(r.errors, []); assert.deepEqual(r.routeBlocked, []);
  assert.deepEqual(r.missing, ['/null', '/__outside_manifest__']);
  const n = r.negativeResults;
  assert.equal(n.positive, 200); assert.equal(n.manifestDenied, 403);
  assert.equal(n.serviceWorker, 'SecurityError'); assert.equal(n.registrations, 0); assert.equal(n.inlineExecuted, false);
  for (const [suffix, directive] of [['-xml-image','img-src'],['-fetch','connect-src'],['-ws','connect-src'],['-image','img-src'],['-css','img-src'],['-sw.js','worker-src'],['-worker.js','worker-src']]) {
    assert(r.violations.some(v => v.uri.endsWith('__drawio_negative__' + suffix) && v.directive === directive), suffix);
  }
  assert(r.violations.some(v => v.directive === 'script-src-elem' && v.uri === 'inline'));
  assert(!r.wire.some(w => w.path.includes('__drawio_negative__')));
  assert(r.policy.includes("script-src 'self';") && !r.policy.includes('unsafe-eval'));
}
