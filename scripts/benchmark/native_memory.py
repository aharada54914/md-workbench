"""Bounded diagnostic observer for an explicitly launched native process tree."""
import argparse
import json
from pathlib import Path
import platform
import sys
import time
import psutil
from measure import SCHEMA, memory_method, sample_tree, write_json


def observe(pid, out):
    out.mkdir(exist_ok=False)
    tracked, count, peak, errors, native_starts = {}, 0, {}, [], {}
    deadline = time.monotonic() + 120
    with (out / 'samples.jsonl').open('x', encoding='utf-8') as raw:
        try:
            roots = {pid: psutil.Process(pid).create_time()}
            while time.monotonic() < deadline:
                sample = sample_tree(psutil, roots, tracked, native_starts=native_starts)
                raw.write(json.dumps(sample) + '\n'); raw.flush()
                count += 1
                if not sample['complete']:
                    errors.append({'time_ns': sample['time_ns'], 'errors': sample['errors'], 'empty': not sample['processes']})
                else:
                    for metric, value in sample['totals'].items():
                        peak[metric] = max(peak.get(metric, 0), value)
                if count == 1:
                    write_json(out / 'ready.json', {'first_sample_ns': sample['time_ns'], 'root_created': roots}, exclusive=True)
                if (out / 'stop').exists():
                    break
                time.sleep(.05)
            else:
                errors.append({'reason': 'observer timeout'})
        except (psutil.Error, OSError, ValueError) as error:
            failure = {'time_ns': time.monotonic_ns(), 'reason': str(error), 'type': type(error).__name__}
            errors.append(failure)
            raw.write(json.dumps({'observer_error': failure}) + '\n')
        except KeyboardInterrupt:
            errors.append({'reason': 'Operator cancelled observation'})
    write_json(out / 'memory.json', {
        'schema': SCHEMA, 'memory_method': memory_method(), 'sample_interval_s': .05,
        'architecture': platform.machine(), 'host_platform': platform.platform(),
        'python': platform.python_version(), 'psutil': psutil.__version__,
        'observer_argv': [sys.executable, str(Path(__file__).resolve()), '--pid', str(pid), '--out', str(out)],
        'status': 'failed' if errors else 'success', 'sample_count': count,
        'peak': peak, 'errors': errors,
        'limitations': ['Diagnostic interval includes CDP observation overhead.',
                        'Cold sampling starts after process launch; earlier allocations may be missed.',
                        'Shared pages are double-counted in summed working set.',
                        'Summed physical footprint is not unique application or coalition memory.',
                        'Independent WebKit/XPC helpers may not be discovered; tree coverage is not guaranteed.',
                        'Diagnostic only: lacks fixture, app and machine comparison metadata.'],
    }, exclusive=True)
    return 1 if errors else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    return observe(args.pid, args.out)


if __name__ == '__main__':
    sys.exit(main())
