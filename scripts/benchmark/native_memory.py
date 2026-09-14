"""Bounded diagnostic observer for an explicitly launched native process tree."""
import argparse
import json
from pathlib import Path
import sys
import time
import psutil
from measure import sample_tree, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(exist_ok=False)
    roots = {args.pid: psutil.Process(args.pid).create_time()}
    tracked, count, peak, errors = {}, 0, {}, []
    deadline = time.monotonic() + 120
    with (args.out / 'samples.jsonl').open('x', encoding='utf-8') as raw:
        while time.monotonic() < deadline:
            sample = sample_tree(psutil, roots, tracked)
            raw.write(json.dumps(sample) + '\n'); raw.flush()
            count += 1
            if not sample['complete']:
                errors.append({'time_ns': sample['time_ns'], 'errors': sample['errors'], 'empty': not sample['processes']})
            for metric, value in sample['totals'].items():
                peak[metric] = max(peak.get(metric, 0), value)
            if count == 1:
                write_json(args.out / 'ready.json', {'first_sample_ns': sample['time_ns'], 'root_created': roots}, exclusive=True)
            if (args.out / 'stop').exists():
                break
            time.sleep(.05)
        else:
            errors.append({'reason': 'observer timeout'})
    write_json(args.out / 'memory.json', {
        'status': 'failed' if errors else 'success', 'sample_count': count,
        'peak': peak, 'errors': errors,
        'limitations': ['Diagnostic interval includes CDP observation overhead.',
                        'Cold sampling starts after process launch; earlier allocations may be missed.',
                        'Shared pages are double-counted in summed working set.'],
    }, exclusive=True)
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
