import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readManifest, validateManifest, parseArgs, verifyObservation, verifyAssets } from './contract.mjs';
const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const fixture = JSON.parse(await fs.readFile(new URL('../../docs/md-workbench/drawio-vanilla-observation.json', import.meta.url)));

test('fixed manifest count and digest', async () => assert.equal((await readManifest()).files.length, 2308));
for (const [name, mutation] of [
  ['traversal', m => {m.files[0].path='../outside';}],
  ['absolute', m => {m.files[0].path='/outside';}],
  ['duplicate', m => {m.files[1].path=m.files[0].path;}],
  ['wrong asset hash', m => {m.files[0].sha256='0'.repeat(64);}]
]) test(`untrusted manifest ${name} rejected`, async () => {
  const m=await readManifest();mutation(m);
  assert.throws(() => validateManifest(Buffer.from(JSON.stringify(m))), /digest mismatch/);
});
test('oversized manifest rejected before JSON parsing', () => assert.throws(() => validateManifest(Buffer.alloc(600001)), /too large/));
test('strict CLI rejects unknown, duplicate and missing values', () => {
  for (const args of [['--unknown','x'],['--work-dir','x','--work-dir','y'],['--work-dir']]) assert.throws(() => parseArgs(args,['--work-dir']));
  assert.deepEqual(parseArgs(['--work-dir','x'],['--work-dir']),{'--work-dir':'x'});
});
test('recorded observation passes; missing CSP or edited result fails', () => {
  verifyObservation(fixture);
  for (const patch of [{violations:[]},{result:'startup-timeout'},{routeBlocked:['http://unexpected.invalid']},{saved:[{after:false,before:true,uncompressed:true}]}]) assert.throws(() => verifyObservation({...fixture,...patch}));
});
test('asset root symlink rejected', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'drawio-test-'));
  try { await fs.symlink(dir,path.join(dir,'assets'));await assert.rejects(verifyAssets(dir,await readManifest()),/symlink/); }
  finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('Python extraction path validator rejects escapes even under optimized Python', () => {
  const code=`import sys;sys.path.insert(0,${JSON.stringify(scriptDir)});from extractor import safe_path
for bad in ['../x','/x','a//b','a/./b','a\\\\b','C:x','a\\x00b']:
 try: safe_path(bad)
 except ValueError: pass
 else: raise RuntimeError(bad)
safe_path('images/a.png')`;
  const child=spawnSync('python3',['-B','-O','-c',code],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
});
test('runner rejects unknown mode without creating output', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'drawio-test-'));const out=path.join(dir,'out');
  try {
    const child=spawnSync(process.execPath,[path.join(scriptDir,'runner.mjs'),'--work-dir',dir,'--output-dir',out,'--mode','typo'],{encoding:'utf8'});
    assert.notEqual(child.status,0);await assert.rejects(fs.stat(out),{code:'ENOENT'});
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
const workDir=process.env.DRAWIO_SPIKE_TEST_WORK_DIR;
test('partial server startup failure closes first listener and exits nonzero', {skip:!workDir}, async () => {
  const occupied=net.createServer();await new Promise((resolve,reject)=>{occupied.once('error',reject);occupied.listen(16631,'127.0.0.1',resolve);});
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'drawio-startup-test-'));
  try {
    const child=spawn(process.execPath,[path.join(scriptDir,'runner.mjs'),'--work-dir',workDir,'--output-dir',path.join(dir,'out'),'--mode','approved-xml-negative'],{stdio:'ignore'});
    const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
    const code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);assert.equal(code,1);
    const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(16632,'127.0.0.1',resolve);});await new Promise(resolve=>probe.close(resolve));
    const report=JSON.parse(await fs.readFile(path.join(dir,'out/report.json')));assert.equal(report.result,'harness-error');
  } finally {await new Promise(resolve=>occupied.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});

test('existing extraction and output directories are preserved', {skip:!workDir}, async () => {
  const extraction=spawnSync('python3',['-B',path.join(scriptDir,'extractor.py'),'--work-dir',workDir],{encoding:'utf8'});
  assert.notEqual(extraction.status,0);assert.match(extraction.stderr,/refusing overwrite/);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'drawio-existing-test-'));
  try {
    await fs.writeFile(path.join(dir,'sentinel'),'keep');
    const run=spawnSync(process.execPath,[path.join(scriptDir,'runner.mjs'),'--work-dir',workDir,'--output-dir',dir,'--mode','approved-xml-negative'],{encoding:'utf8'});
    assert.notEqual(run.status,0);assert.equal(await fs.readFile(path.join(dir,'sentinel'),'utf8'),'keep');
    assert.deepEqual(await fs.readdir(dir),['sentinel']);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
