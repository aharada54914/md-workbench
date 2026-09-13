import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from PIL import Image
import psutil

import measure
import windows_frames as frames
from test_measure import metadata


class FrameContractTests(unittest.TestCase):
    def test_capture_bounds_never_escape_client(self):
        client = (-100, 20, 300, 220)
        self.assertEqual(frames.region_bounds(client, [10, 10, 80, 40]), (-90, 30, -10, 70))
        for region in [[-1, 0, 10, 10], [0, 0, 401, 10], [0, 195, 10, 10], [0, 0, 0, 10]]:
            with self.assertRaises(ValueError): frames.region_bounds(client, region)

    def test_matching_does_not_resize_or_hide_unreadable_pixels(self):
        white, black = Image.new('RGB', (20, 10), 'white'), Image.new('RGB', (20, 10), 'black')
        self.assertEqual(frames.difference(white, white), 0)
        self.assertEqual(frames.difference(white, black), 255)
        with self.assertRaises(ValueError): frames.difference(white, Image.new('RGB', (1, 1)))

    def test_first_match_is_immutable(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            frames.publish(out, 'body', {'time_ns': 123, 'evidence': 'test'})
            with self.assertRaises(FileExistsError): frames.publish(out, 'body', {'time_ns': 456})
            self.assertEqual(json.loads((out / 'body.json').read_text())['time_ns'], 123)

    @unittest.skipUnless(sys.platform == 'win32', 'Native Windows capture; not exercised by Linux')
    def test_native_foreground_capture_and_observer_cli(self):
        import tkinter as tk
        api = frames.window_api()
        root = tk.Tk()
        root.title('MDW synthetic frame test')
        root.geometry('400x200+100+100')
        root.attributes('-topmost', True)
        canvas = tk.Canvas(root, width=400, height=200, background='white', highlightthickness=0)
        canvas.pack(fill='both', expand=True)
        canvas.create_rectangle(20, 20, 120, 80, fill='black')
        canvas.create_text(200, 120, text='Synthetic document frame')
        try:
            root.update(); root.lift(); root.focus_force(); root.update()
            deadline = time.monotonic() + 5
            observed = None
            while observed is None and time.monotonic() < deadline:
                root.update()
                observed = frames.capture(api, {os.getpid()}, [10, 10, 150, 90])
                time.sleep(.05)
            self.assertIsNotNone(observed, 'Synthetic test window did not obtain foreground')
            pixels, stamp = observed
            self.assertEqual(pixels.size, (150, 90))
            self.assertGreaterEqual(stamp['time_ns'], stamp['capture_begin_ns'])
            self.assertIsNone(frames.capture(api, {-1}, [10, 10, 150, 90]))
            with tempfile.TemporaryDirectory() as directory:
                out = Path(directory)
                reference = out / 'reference.png'; pixels.save(reference)
                meta = metadata('screen-sampled')
                measure.write_json(out / 'result.json', {'metadata': meta})
                measure.write_json(out / 'request.json', {'t0_ns': time.monotonic_ns(),
                    'root_pids': [os.getpid()], 'root_created': {str(os.getpid()): psutil.Process().create_time()}})
                completed = subprocess.run([sys.executable, frames.__file__, 'observe', '--out', str(out),
                    '--body-reference', str(reference), '--body-position', '10', '10',
                    '--viewport-reference', str(reference), '--viewport-position', '10', '10',
                    '--timeout', '5'], capture_output=True, text=True, timeout=10)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(json.loads((out / 'body.json').read_text())['observer'], 'screen-sampled')
                self.assertTrue((out / 'viewport.json').exists())
        finally:
            root.destroy()


if __name__ == '__main__':
    unittest.main(verbosity=2)
