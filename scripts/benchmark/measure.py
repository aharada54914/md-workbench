#!/usr/bin/env python3
"""T03: per-trial process-tree measurement with explicit render observations.

No renderer event is guessed from process creation, a window title, or a sleep.
Run output is local evidence; inspect metadata before publishing it.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
import uuid

SCHEMA = 1
MODES = ('cold-process', 'cold-cache', 'warm')
ENV_FIELDS = ('machine_id', 'cpu', 'ram_bytes', 'os', 'webview', 'power',
              'display_scale', 'antivirus', 'ai_state', 'diagram_editor_state')
APP_FIELDS = ('name', 'version', 'build', 'configuration')


def write_json(path, value, exclusive=False):
    with path.open('x' if exclusive else 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def validate_metadata(meta):
    for group, fields in [('environment', ENV_FIELDS), ('app', APP_FIELDS)]:
        if not isinstance(meta.get(group), dict):
            raise ValueError(f'Missing {group} metadata')
        for name in fields:
            if meta[group].get(name) in (None, ''):
                raise ValueError(f'Missing {group}.{name}')
            if str(meta[group][name]).startswith('REPLACE'):
                raise ValueError(f'Replace example value for {group}.{name}')
    if meta['app']['build'] != 'release':
        raise ValueError('Performance comparisons require a release build')
    if meta.get('observer') not in ('instrumented-frame', 'manual'):
        raise ValueError('observer must be instrumented-frame or manual')
    if not meta.get('observer_description'):
        raise ValueError('Describe the body/viewport observation method')


def sample_tree(psutil, roots, tracked):
    """Retain discovered descendants across reparenting; reject PID reuse."""
    errors = []
    for pid, born in list(roots.items()) + list(tracked.items()):
        try:
            proc = psutil.Process(pid)
            if proc.create_time() != born:
                continue
            tracked[pid] = born
            for child in proc.children(recursive=True):
                tracked[child.pid] = child.create_time()
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            errors.append({'pid': pid, 'reason': 'discovery-access-denied'})
    processes = []
    for pid, born in list(tracked.items()):
        try:
            proc = psutil.Process(pid)
            if proc.create_time() != born:
                del tracked[pid]
                continue
            mem = proc.memory_info()
            row = {'pid': pid, 'created': born, 'name': proc.name(), 'rss_bytes': mem.rss}
            if sys.platform == 'win32':
                # psutil maps these to WorkingSetSize and PrivateUsage.
                row['working_set_bytes'] = mem.wset
                row['private_bytes'] = mem.private
            processes.append(row)
        except psutil.NoSuchProcess:
            tracked.pop(pid, None)
        except psutil.AccessDenied:
            errors.append({'pid': pid, 'reason': 'memory-access-denied'})
    metrics = ('working_set_bytes', 'private_bytes') if sys.platform == 'win32' else ('rss_bytes',)
    totals = {metric: sum(p[metric] for p in processes) for metric in metrics}
    return {'time_ns': time.monotonic_ns(), 'processes': processes,
            'totals': totals, 'complete': not errors and bool(processes), 'errors': errors}


def read_markers(out, t0, end):
    markers = {}
    for name in ('body', 'viewport'):
        path = out / f'{name}.json'
        if not path.exists():
            continue
        try:
            marker = json.loads(path.read_text(encoding='utf-8'))
            stamp = marker['time_ns']
            if not isinstance(stamp, int) or isinstance(stamp, bool) or not t0 <= stamp <= end:
                raise ValueError(f'Invalid {name} timestamp')
            if not marker.get('evidence'):
                raise ValueError(f'Missing {name} observation evidence')
            markers[name] = marker
        except (json.JSONDecodeError, KeyError) as error:
            raise ValueError(f'Malformed {name} marker') from error
    if 'viewport' in markers and ('body' not in markers or
            markers['viewport']['time_ns'] < markers['body']['time_ns']):
        raise ValueError('Viewport marker must follow body marker')
    return markers


def record(args):
    import psutil
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        raise ValueError('timeout must be finite and positive')
    if not math.isfinite(args.interval) or args.interval < 0.02:
        raise ValueError('interval must be finite and at least 20 ms')
    if args.mode == 'warm' and not args.root_pid:
        raise ValueError('warm requires --root-pid for the already-running application')
    if args.mode != 'warm' and args.root_pid:
        raise ValueError('--root-pid is only allowed for warm trials')
    if args.mode == 'cold-cache' and not args.reboot_evidence:
        raise ValueError('cold-cache requires --reboot-evidence; the harness never flushes OS caches')
    meta = json.loads(args.metadata.read_text(encoding='utf-8'))
    validate_metadata(meta)
    fixture = args.fixture.resolve(strict=True)
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or '{fixture}' not in command:
        raise ValueError('command must contain a separate {fixture} argument')
    command = [str(fixture) if arg == '{fixture}' else arg for arg in command]
    executable = shutil.which(command[0])
    if executable is None:
        raise ValueError('Launcher executable not found')
    if args.mode != 'warm':
        for proc in psutil.process_iter(['exe']):
            existing = proc.info.get('exe')
            if existing and Path(existing).resolve() == Path(executable).resolve():
                raise ValueError('Application executable is already running; use warm or close it first')
    assets = [Path(p).resolve(strict=True) for p in args.asset]
    inputs = [fixture, *assets]
    fixture_hashes = [digest(path) for path in inputs]
    try:
        roots = {pid: psutil.Process(pid).create_time() for pid in args.root_pid}
    except psutil.Error as error:
        raise ValueError(f'Warm root process is unavailable: {error}') from error
    args.out.mkdir(parents=True, exist_ok=False)
    result = {'schema': SCHEMA, 'trial_id': str(uuid.uuid4()), 'metadata': meta, 'mode': args.mode,
              'fixture_hashes': fixture_hashes, 'reboot_evidence': args.reboot_evidence,
              'started_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
              'python': platform.python_version(), 'psutil': psutil.__version__,
              'sample_interval_s': args.interval, 'status': 'incomplete',
              'limitations': ['Sampling can miss short-lived processes.',
                             'Summed resident/working-set memory double-counts shared pages.',
                             'macOS RSS is not physical footprint.']}
    write_json(args.out / 'result.json', result, exclusive=True)
    tracked, samples = {}, []
    t0 = time.monotonic_ns()
    result['t0_ns'] = t0  # immediately before invoking the OS process-open request
    write_json(args.out / 'request.json', {'t0_ns': t0, 'clock': 'time.monotonic_ns'})
    try:
        # No shell expansion, no automatic process termination or cache eviction.
        with (args.out / 'launcher.log').open('wb') as log:
            launcher = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
            if args.mode != 'warm':
                roots[launcher.pid] = psutil.Process(launcher.pid).create_time()
            with (args.out / 'samples.jsonl').open('x', encoding='utf-8') as raw:
                deadline = time.monotonic() + args.timeout
                while time.monotonic() < deadline:
                    sample = sample_tree(psutil, roots, tracked)
                    raw.write(json.dumps(sample) + '\n')
                    raw.flush()
                    samples.append(sample)
                    markers = read_markers(args.out, t0, time.monotonic_ns())
                    if len(markers) == 2:
                        break
                    if not sample['processes'] and not sample['errors']:
                        raise ValueError('Measured tree exited; do not measure a forwarding launcher as the app')
                    time.sleep(args.interval)
            result['markers'] = read_markers(args.out, t0, time.monotonic_ns())
            if len(result['markers']) != 2:
                raise ValueError('Render observation timeout; no guessed startup latency')
            if fixture_hashes != [digest(path) for path in inputs]:
                raise ValueError('Input bytes changed during the trial')
            if not samples or not all(s['complete'] for s in samples):
                raise ValueError('Incomplete process-tree memory observation')
            result['status'] = 'success'
    except (OSError, ValueError, psutil.Error) as error:
        result.update(status='failed', reason=str(error))
    except KeyboardInterrupt:
        result.update(status='interrupted', reason='Operator cancelled recording')
    finally:
        result['end_ns'] = time.monotonic_ns()
        result['sample_count'] = len(samples)
        result['memory_peak'] = {
            metric: max(s['totals'][metric] for s in samples)
            for metric in (samples[0]['totals'] if samples else {})}
        write_json(args.out / 'result.json', result)
    return 0 if result['status'] == 'success' else 1


def percentile(values, quantile):
    """Linear interpolation (Hyndman-Fan type 7), also used by numpy default."""
    if not values:
        return None
    values = sorted(values)
    index = (len(values) - 1) * quantile
    low, high = math.floor(index), math.ceil(index)
    return values[low] + (values[high] - values[low]) * (index - low)


def summarize(records, minimum_cold=30, minimum_warm=50):
    groups = {}
    seen = set()
    for result in records:
        if result.get('schema') != SCHEMA:
            raise ValueError('Unknown result schema')
        trial_id = result.get('trial_id')
        if not isinstance(trial_id, str) or not trial_id or trial_id in seen:
            raise ValueError('Missing or duplicate trial identity')
        seen.add(trial_id)
        validate_metadata(result['metadata'])
        if result['mode'] not in MODES:
            raise ValueError('Unknown mode')
        identity = {'metadata': result['metadata'], 'mode': result['mode'],
                    'fixture_hashes': result['fixture_hashes']}
        key = json.dumps(identity, sort_keys=True)
        group = groups.setdefault(key, {'identity': identity, 'trials': []})
        group['trials'].append(result)
    output = []
    for group in groups.values():
        trials = group.pop('trials')
        valid, reasons = [], []
        for trial in trials:
            if trial['status'] != 'success':
                reasons.append(trial.get('reason', trial['status']))
                continue
            try:
                t0, t1, t2 = (trial['t0_ns'], trial['markers']['body']['time_ns'],
                              trial['markers']['viewport']['time_ns'])
                if not all(isinstance(t, int) and not isinstance(t, bool) for t in (t0, t1, t2)):
                    raise ValueError('Invalid timestamps')
                if not t0 <= t1 <= t2 <= trial['end_ns'] or trial['sample_count'] < 1:
                    raise ValueError('Invalid timeline or missing samples')
                if not trial['memory_peak'] or any(not math.isfinite(v) or v < 0
                                                  for v in trial['memory_peak'].values()):
                    raise ValueError('Invalid memory measurements')
                valid.append(trial)
            except (KeyError, ValueError, TypeError) as error:
                reasons.append(str(error))
        fields = {'body_ms': [(r['markers']['body']['time_ns'] - r['t0_ns']) / 1e6 for r in valid],
                  'viewport_ms': [(r['markers']['viewport']['time_ns'] - r['t0_ns']) / 1e6 for r in valid]}
        # Never fill a missing OS metric with zero or pool unlike metrics.
        metrics = set.intersection(*(set(r['memory_peak']) for r in valid)) if valid else set()
        fields.update({metric: [r['memory_peak'][metric] for r in valid] for metric in sorted(metrics)})
        required = minimum_warm if group['identity']['mode'] == 'warm' else minimum_cold
        group.update(attempted=len(trials), successful=len(valid), failed=len(reasons),
                     failure_reasons=reasons, required_samples=required,
                     sample_target_met=len(valid) >= required,
                     eligible_for_latency_comparison=(len(valid) >= required and
                         group['identity']['metadata']['observer'] == 'instrumented-frame'),
                     metrics={k: {'n': len(v), 'p50': percentile(v, .5), 'p95': percentile(v, .95)}
                              for k, v in fields.items()})
        output.append(group)
    return {'schema': SCHEMA, 'percentile_method': 'linear type 7', 'groups': output}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    rec = commands.add_parser('record')
    rec.add_argument('--metadata', type=Path, required=True)
    rec.add_argument('--fixture', type=Path, required=True)
    rec.add_argument('--asset', action='append', default=[])
    rec.add_argument('--out', type=Path, required=True)
    rec.add_argument('--mode', choices=MODES, required=True)
    rec.add_argument('--root-pid', type=int, action='append', default=[])
    rec.add_argument('--reboot-evidence')
    rec.add_argument('--timeout', type=float, default=30)
    rec.add_argument('--interval', type=float, default=.1)
    rec.add_argument('command', nargs=argparse.REMAINDER)
    mark = commands.add_parser('mark')
    mark.add_argument('--out', type=Path, required=True)
    mark.add_argument('--stage', choices=('body', 'viewport'), required=True)
    mark.add_argument('--evidence', required=True)
    mark.add_argument('--time-ns', type=int)
    summary = commands.add_parser('summarize')
    summary.add_argument('results', type=Path, nargs='+')
    summary.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == 'record':
            return record(args)
        if args.action == 'mark':
            value = {'time_ns': args.time_ns if args.time_ns is not None else time.monotonic_ns(),
                     'evidence': args.evidence}
            # Atomic publication avoids readers observing partially written JSON.
            temporary = args.out / f'{args.stage}-{os.getpid()}.tmp'
            write_json(temporary, value, exclusive=True)
            try:
                os.link(temporary, args.out / f'{args.stage}.json')
            finally:
                temporary.unlink()
            return 0
        records = [json.loads(p.read_text(encoding='utf-8')) for p in args.results]
        write_json(args.out, summarize(records), exclusive=True)
        return 0
    except (OSError, ValueError, KeyError, ImportError) as error:
        parser.exit(2, f'{error}\n')


if __name__ == '__main__':
    sys.exit(main())
