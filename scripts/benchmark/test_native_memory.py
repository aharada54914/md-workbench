import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import native_memory
import measure
from test_measure import metadata
import types


class FailurePersistenceTests(unittest.TestCase):
    def test_record_unavailable_warm_root_preserves_failure_without_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); fixture = root / 'synthetic.md'; fixture.write_text('# synthetic')
            meta = root / 'metadata.json'; measure.write_json(meta, metadata())
            args = types.SimpleNamespace(timeout=1, interval=.1, mode='warm', root_pid=[42],
                reboot_evidence=None, metadata=meta, fixture=fixture, asset=[], out=root / 'trial',
                command=[native_memory.sys.executable, '-c', 'pass', '{fixture}'])
            with patch.object(native_memory.psutil, 'Process', side_effect=native_memory.psutil.NoSuchProcess(42)), \
                    patch.object(measure.subprocess, 'Popen') as launch:
                self.assertEqual(measure.record(args), 1)
                launch.assert_not_called()
            result = json.loads((args.out / 'result.json').read_text())
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['memory_peak'], {})
            raw = json.loads((args.out / 'samples.jsonl').read_text())
            self.assertEqual(raw['observer_error']['type'], 'NoSuchProcess')

    def test_missing_root_keeps_raw_error_and_failed_result(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'diagnostic'
            with patch.object(native_memory.psutil, 'Process', side_effect=native_memory.psutil.NoSuchProcess(42)):
                self.assertEqual(native_memory.observe(42, out), 1)
            result = json.loads((out / 'memory.json').read_text())
            raw = json.loads((out / 'samples.jsonl').read_text())
            self.assertEqual(result['schema'], 2)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['peak'], {})
            self.assertEqual(raw['observer_error']['type'], 'NoSuchProcess')
            self.assertFalse((out / 'ready.json').exists())

    def test_diagnostic_keeps_good_peak_and_failed_native_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'diagnostic'
            samples = iter([
                {'time_ns': 1, 'complete': True, 'totals': {'rss_bytes': 12}, 'processes': [{'pid': 1}], 'errors': []},
                {'time_ns': 2, 'complete': False, 'totals': {}, 'processes': [{'pid': 1}],
                 'errors': [{'pid': 1, 'reason': 'footprint-read-failed', 'errno': 1}]}])
            def sample(*args, **kwargs):
                value = next(samples)
                if value['time_ns'] == 2: (out / 'stop').touch()
                return value
            with patch.object(native_memory, 'sample_tree', side_effect=sample), patch.object(native_memory.time, 'sleep'):
                self.assertEqual(native_memory.observe(os.getpid(), out), 1)
            result = json.loads((out / 'memory.json').read_text())
            self.assertEqual(result['peak'], {'rss_bytes': 12})
            self.assertEqual(result['sample_count'], 2)
            self.assertEqual(len((out / 'samples.jsonl').read_text().splitlines()), 2)

    def test_record_missing_native_sample_persists_without_finally_key_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); fixture = root / 'synthetic.md'; fixture.write_text('# synthetic')
            meta = root / 'metadata.json'; measure.write_json(meta, metadata())
            args = types.SimpleNamespace(timeout=1, interval=.1, mode='warm', root_pid=[os.getpid()],
                reboot_evidence=None, metadata=meta, fixture=fixture, asset=[], out=root / 'trial',
                command=[native_memory.sys.executable, '-c', 'pass', '{fixture}'])
            good = {'time_ns': 1, 'complete': True, 'totals': {'summed_physical_footprint_bytes': 12},
                    'processes': [{'pid': 1}], 'errors': []}
            bad = {'time_ns': 2, 'complete': False, 'totals': {}, 'processes': [{'pid': 1}],
                   'errors': [{'pid': 1, 'reason': 'footprint-read-failed', 'errno': 1}]}
            markers = {'body': {'time_ns': 1}, 'viewport': {'time_ns': 2}}
            with patch.object(measure, 'sample_tree', side_effect=[good, bad]), \
                    patch.object(measure, 'read_markers', side_effect=[{}, markers, markers]), \
                    patch.object(measure.time, 'sleep'), patch.object(measure.subprocess, 'Popen'):
                self.assertEqual(measure.record(args), 1)
            result = json.loads((args.out / 'result.json').read_text())
            self.assertEqual(result['status'], 'failed')
            self.assertIn('Incomplete', result['reason'])
            self.assertEqual(result['memory_peak'], good['totals'])
            self.assertEqual(len((args.out / 'samples.jsonl').read_text().splitlines()), 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
