import { createHash } from 'node:crypto';
import { commands } from './native-receipts.mjs';

export const profileVersion = 2;
export const supportedWry = '0.55.1';
const supportedWryChecksum = '186f9871daa55fd9c016578b810d149de58367113db7fb72b462d2323ce19514';
const supportedWrySource = 'registry+https://github.com/rust-lang/crates.io-index';
export const minimumObservationMs = 500;
const modes = ['--expect-disabled', '--frame-active', '--frame-roundtrip'];

export function parseOptions(args) {
  const [binary, out, ...flags] = args;
  if (!binary || !out || flags.some(flag => ![...modes, '--observations-only'].includes(flag)) ||
      new Set(flags).size !== flags.length || flags.filter(flag => modes.includes(flag)).length > 1) {
    throw Error('Usage: windows.mjs BINARY OUTPUT [--expect-disabled|--frame-active|--frame-roundtrip] [--observations-only]');
  }
  return { binary, out, mode:flags.find(flag => modes.includes(flag)) ?? '--spike', observationsOnly:flags.includes('--observations-only') };
}

export function wryLockEvidence(lock) {
  const entries = lock.split('[[package]]').filter(entry => /^name = "wry"$/m.test(entry));
  if (entries.length !== 1) throw Error('Exactly one locked Wry package required');
  const field = name => entries[0].match(new RegExp(`^${name} = "([^"\\r\\n]+)"$`, 'm'))?.[1];
  const version = field('version'), checksum = field('checksum'), source = field('source');
  if (!version || !/^[a-f0-9]{64}$/.test(checksum ?? '') || !source?.startsWith('registry+')) throw Error('Incomplete Wry lock evidence');
  return { version, checksum, source, cargoLockSha256:createHash('sha256').update(lock).digest('hex') };
}

const exactCounts = (counts, expected) => counts && Object.keys(counts).length === commands.length && commands.every(command => counts[command] === expected);
const duration = value => Number.isFinite(value) && value >= minimumObservationMs;
const wrapperPassed = value => value?.bridge === 'sent' && value.status === 'passed' && exactCounts(value.receipts, 1) && !value.reason;

// The exception is a single observed transport shape, never arbitrary unsupported.
// This function runs only after process cleanup, and requires positive completion.
export function classifyReport(report) {
  const failure = reason => ({ status:'failed', exitCode:1, reason });
  if (!Array.isArray(report.errors) || report.errors.length || report.cleanup?.ownedProcessExited !== true || report.observationCompleted !== true || report.checks?.ownedProcessAliveAfterObservations !== true) {
    return failure('incomplete_or_failed_observation');
  }
  if (report.profile !== 'windows-wry-bounded-observations') {
    if (report.profile !== 'strict-receipts') return failure('unknown_profile');
    const status = report.status;
    if (!['passed_default_disabled','passed_measured_subset','unsupported','failed'].includes(status)) return failure('unknown_strict_status');
    return { status, exitCode:status.startsWith('passed_') ? 0 : 1 };
  }
  if (report.profileVersion !== profileVersion || report.platform !== 'win32' || report.wryLock?.version !== supportedWry ||
      report.wryLock?.checksum !== supportedWryChecksum || report.wryLock?.source !== supportedWrySource ||
      !/^[a-f0-9]{64}$/.test(report.wryLock?.cargoLockSha256 ?? '') ||
      typeof report.engine !== 'string' || !report.engine || typeof report.osRelease !== 'string' || !report.osRelease ||
      report.productAcceptance !== 'unverified' || report.nativeReceiptCoverage !== 'unsupported') return failure('unsupported_profile_environment');
  const checks = report.checks ?? {};
  if (report.mode === '--expect-disabled') {
    return checks.defaultFeatureIgnoresLaunchFlag === true ? {status:'passed_default_disabled', exitCode:0} : failure('default_fixture_not_observed');
  }
  const frame = ['--frame-active','--frame-roundtrip'].includes(report.mode);
  if (!frame && report.mode !== '--spike') return failure('unknown_mode');
  const wrapper = frame ? report.nativeControl : report.nativeCustom?.wrapper;
  const child = frame ? report.nativeChild : report.nativeCustom?.child;
  if (checks.genuineNativeControl !== true || checks.wrapperCounterPositive !== true || !wrapperPassed(wrapper) ||
      child?.bridge !== 'sent' || child.status !== 'unsupported' || child.reason !== 'no_native_receipt' || !exactCounts(child.receipts, 0) ||
      !duration(report.childDirectIpc?.observedMs) || report.childDirectIpc.wrapperCalls !== 0 || !exactCounts(report.childDirectIpc.nativeReceiptDelta, 0) ||
      checks.noForwardingOnObservedPaths !== true || !exactCounts(report.finalNativeReceiptDelta, 0)) return failure('native_observation_incomplete_or_changed');
  if (frame) {
    const preflight = report.preflight;
    if (preflight?.status !== 'starting' || preflight.hostOrigin !== 'http://mdwdiagramhost.localhost' ||
        preflight.frames?.foreign?.selectedSource !== true || preflight.frames.foreign.origin !== 'http://mdwdiagramforeign.localhost' || preflight.frames.foreign.result !== 'ignored' ||
        preflight.frames?.sibling?.selectedSource !== false || preflight.frames.sibling.origin !== 'http://mdwdiagramfixture.localhost' || preflight.frames.sibling.result !== 'ignored' ||
        checks.retiredStateUnchanged !== true || checks.parentMessageWrapperCalls !== 0 || !duration(report.parentMessageObservationMs)) return failure('frame_provenance_or_retirement_incomplete');
    if (report.mode === '--frame-active') {
      const rejected = report.active?.frames?.selectedRejected;
      if (report.active?.status !== 'schema' || rejected?.selectedSource !== true || rejected.origin !== 'http://mdwdiagramfixture.localhost' || rejected.reason !== 'schema') return failure('active_schema_rejection_missing');
    } else if (report.roundtrip?.status !== 'passed_roundtrip' || report.roundtrip.childOrigin !== 'http://mdwdiagramfixture.localhost' || report.roundtrip.candidate !== true) return failure('frame_roundtrip_missing');
  } else {
    if (['exactOriginRoundtrip','pluginAclDenied','cspIsSeparateFromNativeReceipt','popupDenied','reloadRetired'].some(key => checks[key] !== true)) return failure('required_spike_observation_missing');
  }
  return { status:'passed_bounded_observations', exitCode:0 };
}
