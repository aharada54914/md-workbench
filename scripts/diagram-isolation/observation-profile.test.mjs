import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from './native-receipts.mjs';
import { parseOptions, wryLockEvidence, classifyReport, profileVersion } from './observation-profile.mjs';

// Unit tests run before Cargo generates the ignored lockfile on a clean checkout.
// The native runner must still read and validate its actual build's Cargo.lock.
const lockFixture = [
  'version = 4', '', '[[package]]', 'name = "wry"', 'version = "0.55.1"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  'checksum = "186f9871daa55fd9c016578b810d149de58367113db7fb72b462d2323ce19514"', '',
].join('\n');

const counts = n => Object.fromEntries(commands.map(command => [command, n]));
const baseline = (mode='--spike') => ({
  profile:'windows-wry-bounded-observations', profileVersion, mode, platform:'win32', osRelease:'win22', engine:'131.0.2903.86',
  wryLock:wryLockEvidence(lockFixture),
  status:'unsupported', errors:[], cleanup:{ownedProcessExited:true}, observationCompleted:true,
  productAcceptance:'unverified', nativeReceiptCoverage:'unsupported', sessionNegativeCoverage:'unit_only',
  checks:{ownedProcessAliveAfterObservations:true,genuineNativeControl:true, wrapperCounterPositive:true, noForwardingOnObservedPaths:true,
    exactOriginRoundtrip:true, pluginAclDenied:true, cspIsSeparateFromNativeReceipt:true, popupDenied:true, reloadRetired:true,
    retiredStateUnchanged:true, parentMessageWrapperCalls:0},
  nativeCustom:{wrapper:{bridge:'sent', status:'passed', receipts:counts(1)}, child:{bridge:'sent',status:'unsupported',reason:'no_native_receipt',receipts:counts(0)}},
  nativeControl:{bridge:'sent',status:'passed',receipts:counts(1)},
  nativeChild:{bridge:'sent',status:'unsupported',reason:'no_native_receipt',receipts:counts(0)},
  childDirectIpc:{observedMs:500,wrapperCalls:0,nativeReceiptDelta:counts(0)}, finalNativeReceiptDelta:counts(0), parentMessageObservationMs:500,
  preflight:{status:'starting',hostOrigin:'http://mdwdiagramhost.localhost',frames:{
    foreign:{selectedSource:true,origin:'http://mdwdiagramforeign.localhost',result:'ignored'},
    sibling:{selectedSource:false,origin:'http://mdwdiagramfixture.localhost',result:'ignored'}}},
  active:{status:'schema',frames:{selectedRejected:{selectedSource:true,origin:'http://mdwdiagramfixture.localhost',reason:'schema'}}},
  roundtrip:{status:'passed_roundtrip',childOrigin:'http://mdwdiagramfixture.localhost',candidate:true},
});
const failed = report => { const result=classifyReport(report); assert.equal(result.status,'failed');assert.equal(result.exitCode,1); };

test('CLI is strict by default; explicit profile composes with one mode in either order',()=>{
  assert.deepEqual(parseOptions(['binary','out']),{binary:'binary',out:'out',mode:'--spike',observationsOnly:false});
  for(const flags of [['--observations-only','--frame-active'],['--frame-active','--observations-only']])
    assert.equal(parseOptions(['binary','out',...flags]).observationsOnly,true);
  for(const args of [[],['binary'],['binary','out','--typo'],['binary','out','--observations-only','--observations-only'],['binary','out','--frame-active','--frame-roundtrip']])
    assert.throws(()=>parseOptions(args),/Usage/);
});
test('lock evidence records exact Wry entry and full lock hash, rejecting ambiguous or missing provenance',()=>{
  const lock=lockFixture;
  const evidence=wryLockEvidence(lock);assert.equal(evidence.version,'0.55.1');assert.match(evidence.cargoLockSha256,/^[a-f0-9]{64}$/);
  assert.notEqual(wryLockEvidence(lock+'\n').cargoLockSha256,evidence.cargoLockSha256);
  for(const value of ['',lock+'\n[[package]]\nname = "wry"\n', '[[package]]\nname = "wry"\nversion = "0.55.1"\n']) assert.throws(()=>wryLockEvidence(value));
});
test('LF and CRLF lock evidence preserve provenance and distinct full-file hashes',()=>{
  const lf=wryLockEvidence(lockFixture), crlf=wryLockEvidence(lockFixture.replaceAll('\n','\r\n'));
  assert.equal(crlf.version,lf.version);assert.equal(crlf.source,lf.source);assert.equal(crlf.checksum,lf.checksum);
  assert.notEqual(crlf.cargoLockSha256,lf.cargoLockSha256);
});
test('all three completed bounded modes pass only the measured profile; coverage stays unsupported',()=>{
  for(const mode of ['--spike','--frame-active','--frame-roundtrip']){
    const report=baseline(mode);assert.deepEqual(classifyReport(report),{status:'passed_bounded_observations',exitCode:0});
    assert.equal(report.nativeReceiptCoverage,'unsupported');assert.equal(report.productAcceptance,'unverified');
  }
});
test('strict receipt mode preserves unsupported/nonzero and existing measured pass',()=>{
  const report=baseline();report.profile='strict-receipts';
  assert.deepEqual(classifyReport(report),{status:'unsupported',exitCode:1});
  report.status='passed_measured_subset';assert.equal(classifyReport(report).exitCode,0);
  report.status='unexpected';failed(report);
});
test('default-disabled requires its own completed observation',()=>{
  const report=baseline('--expect-disabled');failed(report);
  report.checks.defaultFeatureIgnoresLaunchFlag=true;assert.equal(classifyReport(report).status,'passed_default_disabled');
  report.cleanup.ownedProcessExited=false;failed(report);
});
const commonFailures = {
  prematureExit:r=>delete r.checks.ownedProcessAliveAfterObservations, errors:r=>r.errors.push('CSP failed'), missingErrors:r=>delete r.errors,
  missingCompletion:r=>delete r.observationCompleted, incomplete:r=>r.observationCompleted=false,
  missingCleanup:r=>delete r.cleanup, cleanupFailure:r=>r.cleanup.ownedProcessExited=false,
  profile:r=>r.profile='arbitrary', version:r=>r.profileVersion=1, os:r=>r.platform='darwin', osRelease:r=>delete r.osRelease,
  engine:r=>r.engine='', wry:r=>r.wryLock.version='0.55.2', missingLock:r=>delete r.wryLock, lockHash:r=>r.wryLock.cargoLockSha256='',
  changedWrySource:r=>r.wryLock.source='registry+https://example.invalid/index', changedWryChecksum:r=>r.wryLock.checksum='0'.repeat(64),
  falseAcceptance:r=>r.productAcceptance='passed', falseCoverage:r=>r.nativeReceiptCoverage='denied',
  mainControl:r=>delete r.checks.genuineNativeControl, counter:r=>r.checks.wrapperCounterPositive=false,
  noForwarding:r=>delete r.checks.noForwardingOnObservedPaths, changedFinal:r=>r.finalNativeReceiptDelta[commands[0]]=1,
  missingFinal:r=>delete r.finalNativeReceiptDelta, missingCommand:r=>delete r.childDirectIpc.nativeReceiptDelta[commands[0]],
  wrongType:r=>r.childDirectIpc.nativeReceiptDelta[commands[0]]='0', extraCount:r=>r.childDirectIpc.nativeReceiptDelta.other=0,
  shortInterval:r=>r.childDirectIpc.observedMs=499, noInterval:r=>r.childDirectIpc.observedMs=NaN,
  childForwarding:r=>r.childDirectIpc.wrapperCalls=1,
};
for(const [name,mutate] of Object.entries(commonFailures))test(`fail closed: ${name}`,()=>{
  for(const mode of ['--spike','--frame-active','--frame-roundtrip']){const report=baseline(mode);mutate(report);failed(report);}
});
for(const mode of ['--spike','--frame-active'])test(`${mode}: only exact child/no_native_receipt exception with native positive control`,()=>{
  for(const mutate of [v=>v.bridge='unavailable',v=>v.reason='transport_unavailable',v=>v.status='passed',v=>v.reason='prior_context_unconfirmed',v=>v.receipts[commands[0]]=1,v=>delete v.receipts[commands[0]]]){
    const report=baseline(mode);mutate(mode==='--spike'?report.nativeCustom.child:report.nativeChild);failed(report);
  }
  for(const mutate of [v=>v.status='unsupported',v=>v.bridge='unavailable',v=>v.receipts[commands[0]]=0,v=>v.receipts[commands[0]]=2]){
    const report=baseline(mode);mutate(mode==='--spike'?report.nativeCustom.wrapper:report.nativeControl);failed(report);
  }
});
test('each existing native spike observation remains required',()=>{
  for(const key of ['exactOriginRoundtrip','pluginAclDenied','cspIsSeparateFromNativeReceipt','popupDenied','reloadRetired']){
    const report=baseline();delete report.checks[key];failed(report);
  }
});
test('genuine frame provenance, active schema, valid roundtrip and retirement cannot be skipped or changed',()=>{
  const mutations=[r=>r.preflight.hostOrigin='null',r=>r.preflight.frames.foreign.result='accepted',r=>r.preflight.frames.foreign.selectedSource=false,
    r=>r.preflight.frames.sibling.selectedSource=true,r=>r.preflight.frames.sibling.origin='null',r=>delete r.checks.retiredStateUnchanged,
    r=>r.checks.parentMessageWrapperCalls=1,r=>r.parentMessageObservationMs=499];
  for(const mutate of mutations)for(const mode of ['--frame-active','--frame-roundtrip']){const report=baseline(mode);mutate(report);failed(report);}
  const active=baseline('--frame-active');active.active.frames.selectedRejected.reason='sequence';failed(active);
  const roundtrip=baseline('--frame-roundtrip');roundtrip.roundtrip.candidate=false;failed(roundtrip);
});
