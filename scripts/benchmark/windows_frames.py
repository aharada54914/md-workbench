#!/usr/bin/env python3
"""Observe synthetic document regions in one foreground Windows client window.

Matching proves a reference region was visible at a sampled frame, not that a
renderer event fired at precisely that instant. Never capture the full desktop.
"""
import argparse
import ctypes
from ctypes import wintypes
import json
import math
import os
from pathlib import Path
import sys
import time

from PIL import Image, ImageChops, ImageGrab, ImageStat
import psutil

import measure


def window_api():
    if sys.platform != 'win32':
        raise ValueError('Native frame observation requires Windows desktop')
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    # DPI-aware client coordinates and ImageGrab pixels must refer to the same scale.
    user32.SetProcessDpiAwarenessContext.argtypes = [wintypes.HANDLE]
    if not user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
        user32.GetThreadDpiAwarenessContext.restype = wintypes.HANDLE
        user32.GetAwarenessFromDpiAwarenessContext.argtypes = [wintypes.HANDLE]
        if user32.GetAwarenessFromDpiAwarenessContext(user32.GetThreadDpiAwarenessContext()) != 2:
            raise ValueError('Cannot establish per-monitor DPI-aware screen coordinates')
    return user32


def foreground_client(user32, pids):
    hwnd = user32.GetForegroundWindow()
    if not hwnd or not user32.IsWindowVisible(hwnd):
        return None
    owner = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
    if owner.value not in pids:
        return None
    rect, point = wintypes.RECT(), wintypes.POINT(0, 0)
    if not user32.GetClientRect(hwnd, ctypes.byref(rect)) or not user32.ClientToScreen(hwnd, ctypes.byref(point)):
        raise ValueError('Cannot obtain target client bounds')
    return int(hwnd), (point.x, point.y, point.x + rect.right, point.y + rect.bottom)


def region_bounds(client, region):
    x, y, width, height = region
    if min(x, y) < 0 or min(width, height) <= 0:
        raise ValueError('Region must be a positive client-relative rectangle')
    if x + width > client[2] - client[0] or y + height > client[3] - client[1]:
        raise ValueError('Region extends outside the target client window')
    return (client[0] + x, client[1] + y, client[0] + x + width, client[1] + y + height)


def capture(user32, pids, region):
    before = foreground_client(user32, pids)
    if before is None:
        return None
    hwnd, bounds = before
    rectangle = region_bounds(bounds, region)
    begin = time.monotonic_ns()
    pixels = ImageGrab.grab(bbox=rectangle, window=hwnd).convert('RGB')
    end = time.monotonic_ns()
    # Reject a moved/replaced/occluded-by-foreground window during acquisition.
    if foreground_client(user32, pids) != before:
        return None
    return pixels, {'capture_begin_ns': begin, 'time_ns': end, 'hwnd': hwnd,
                    'region': list(region), 'capture_duration_ms': (end - begin) / 1e6}


def difference(reference, pixels):
    if reference.size != pixels.size:
        raise ValueError('Captured region does not match reference dimensions')
    # Bound to 0..255 per color channel; do not resize or blur unreadable content.
    return sum(ImageStat.Stat(ImageChops.difference(reference.convert('RGB'), pixels.convert('RGB'))).mean) / 3


def publish(out, stage, value):
    temporary = out / f'{stage}-{os.getpid()}.tmp'
    measure.write_json(temporary, value, exclusive=True)
    try:
        os.link(temporary, out / f'{stage}.json')
    finally:
        temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    reference = sub.add_parser('reference')
    reference.add_argument('--pid', type=int, required=True)
    reference.add_argument('--region', type=int, nargs=4, metavar=('X', 'Y', 'W', 'H'), required=True)
    reference.add_argument('--out', type=Path, required=True)
    reference.add_argument('--delay', type=float, default=3,
                           help='Seconds to switch from the terminal to the target window')
    observe = sub.add_parser('observe')
    observe.add_argument('--out', type=Path, required=True, help='Trial directory created by measure.py')
    observe.add_argument('--body-reference', type=Path, required=True)
    observe.add_argument('--body-position', type=int, nargs=2, required=True, metavar=('X', 'Y'))
    observe.add_argument('--viewport-reference', type=Path, required=True)
    observe.add_argument('--viewport-position', type=int, nargs=2, required=True, metavar=('X', 'Y'))
    observe.add_argument('--timeout', type=float, default=30)
    observe.add_argument('--interval', type=float, default=.05)
    observe.add_argument('--max-difference', type=float, default=0,
                         help='Mean absolute RGB difference in 0..255 units; exact matching by default')
    args = parser.parse_args()
    try:
        user32 = window_api()
        if args.action == 'reference':
            if args.out.exists():
                raise ValueError('Reference file already exists')
            if not math.isfinite(args.delay) or not 0 <= args.delay <= 30:
                raise ValueError('Reference delay must be between 0 and 30 seconds')
            time.sleep(args.delay)
            observed = capture(user32, {args.pid}, args.region)
            if observed is None:
                raise ValueError('Target must remain in foreground while taking a reference')
            pixels, _ = observed
            with args.out.open('xb') as stream:
                pixels.save(stream, format='PNG')
            return 0
        if not (math.isfinite(args.interval) and args.interval >= .02 and
                math.isfinite(args.timeout) and args.timeout > 0 and
                math.isfinite(args.max_difference) and 0 <= args.max_difference <= 5):
            raise ValueError('Use interval >= 20 ms, timeout > 0, and difference tolerance 0..5')
        references = {}
        for stage in ('body', 'viewport'):
            path = getattr(args, stage + '_reference')
            with Image.open(path) as image:
                if image.width * image.height > 4_000_000:
                    raise ValueError('Use small reference regions, at most 4 million pixels')
                pixels = image.convert('RGB')
            if max(ImageStat.Stat(pixels).stddev) < 1:
                raise ValueError('A blank/uniform reference cannot prove readable document content')
            references[stage] = (pixels, measure.digest(path),
                                 [*getattr(args, stage + '_position'), *pixels.size])
        deadline = time.monotonic() + args.timeout
        request_path = args.out / 'request.json'
        while not request_path.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        request = json.loads(request_path.read_text(encoding='utf-8'))
        result = json.loads((args.out / 'result.json').read_text(encoding='utf-8'))
        if result['metadata']['observer'] != 'screen-sampled':
            raise ValueError('Set observer=screen-sampled; do not label sampled captures as exact frame events')
        pids = set(request['root_pids'])
        if not pids:
            raise ValueError('No target process identity in the open request')
        measure.write_json(args.out / 'observer.json', {
            'method': 'screen-sampled', 'interval_s': args.interval,
            'max_difference': args.max_difference,
            'references': {stage: {'sha256': value[1], 'region': value[2]}
                           for stage, value in references.items()}}, exclusive=True)
        matched = set()
        with (args.out / 'frame-observations.jsonl').open('x', encoding='utf-8') as raw:
            while time.monotonic() < deadline:
                for pid in pids:
                    if psutil.Process(pid).create_time() != request['root_created'][str(pid)]:
                        raise ValueError('Target PID was reused')
                for stage in ('body', 'viewport'):
                    if stage in matched or stage == 'viewport' and 'body' not in matched:
                        continue
                    reference_pixels, reference_hash, region = references[stage]
                    observed = capture(user32, pids, region)
                    if observed is None:
                        continue
                    pixels, stamp = observed
                    error = difference(reference_pixels, pixels)
                    row = dict(stamp, stage=stage, difference=error,
                               reference_sha256=reference_hash, interval_s=args.interval)
                    raw.write(json.dumps(row) + '\n'); raw.flush()
                    if error <= args.max_difference:
                        publish(args.out, stage, dict(row, evidence='frame-observations.jsonl',
                                                     observer='screen-sampled'))
                        matched.add(stage)
                if len(matched) == 2:
                    return 0
                time.sleep(args.interval)
        raise ValueError('No matching rendered frame before timeout')
    except (OSError, ValueError, KeyError, psutil.Error, Image.DecompressionBombError) as error:
        parser.exit(2, f'{error}\n')


if __name__ == '__main__':
    sys.exit(main())
