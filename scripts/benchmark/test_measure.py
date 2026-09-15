import json
import os
import itertools
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import measure


def metadata(observer='instrumented-frame'):
    return {'environment': {name: 'synthetic-test' for name in measure.ENV_FIELDS},
            'app': {'name': 'synthetic-app', 'version': 'test', 'build': 'release',
                    'configuration': 'no extensions'},
            'observer': observer, 'observer_description': 'synthetic fixture, not a measurement'}


TRIALS = itertools.count()


def result(body_ms=10, mode='cold-process'):
    return {'schema': 1, 'trial_id': f'synthetic-{next(TRIALS)}',
            'metadata': metadata(), 'mode': mode, 'fixture_hashes': ['a' * 64],
            'status': 'success', 't0_ns': 100, 'end_ns': 100_000_100, 'sample_count': 2,
            'markers': {'body': {'time_ns': body_ms * 1_000_000 + 100},
                        'viewport': {'time_ns': 90_000_100}},
            'memory_peak': {'rss_bytes': 100}}


class SummaryTests(unittest.TestCase):
    def test_percentile_interpolation_and_counts(self):
        summary = measure.summarize([result(n) for n in range(1, 31)])['groups'][0]
        self.assertEqual(summary['metrics']['body_ms']['n'], 30)
        self.assertEqual(summary['metrics']['body_ms']['p50'], 15.5)
        self.assertAlmostEqual(summary['metrics']['body_ms']['p95'], 28.55)
        self.assertTrue(summary['eligible_for_latency_comparison'])

    def test_failed_attempt_not_dropped_or_filled_with_zero(self):
        failed = result(); failed.update(status='failed', reason='render timeout')
        group = measure.summarize([failed, result(20)])['groups'][0]
        self.assertEqual((group['attempted'], group['successful'], group['failed']), (2, 1, 1))
        self.assertEqual(group['metrics']['body_ms']['p50'], 20)
        self.assertFalse(group['sample_target_met'])

    def test_all_failures_have_null_percentiles(self):
        failed = result(); failed['status'] = 'failed'
        group = measure.summarize([failed])['groups'][0]
        self.assertIsNone(group['metrics']['body_ms']['p95'])

    def test_environment_fixture_app_and_mode_are_not_pooled(self):
        cases = [result()]
        for path in [('metadata', 'environment', 'machine_id'), ('metadata', 'app', 'configuration'),
                     ('metadata', 'app', 'version')]:
            item = result(); target = item
            for key in path[:-1]: target = target[key]
            target[path[-1]] = 'different'; cases.append(item)
        item = result(); item['fixture_hashes'] = ['b' * 64]; cases.append(item)
        cases += [result(mode='warm'), result(mode='cold-cache')]
        self.assertEqual(len(measure.summarize(cases)['groups']), 7)

    def test_manual_observer_never_becomes_precise_latency(self):
        trials = [result() for _ in range(30)]
        for item in trials: item['metadata'] = metadata('manual')
        group = measure.summarize(trials)['groups'][0]
        self.assertTrue(group['sample_target_met'])
        self.assertFalse(group['eligible_for_latency_comparison'])

    def test_warm_requires_fifty_successful_trials(self):
        self.assertFalse(measure.summarize([result(mode='warm') for _ in range(49)])['groups'][0]['sample_target_met'])
        self.assertTrue(measure.summarize([result(mode='warm') for _ in range(50)])['groups'][0]['sample_target_met'])

    def test_duplicate_trial_cannot_inflate_sample_count(self):
        trial = result()
        with self.assertRaises(ValueError): measure.summarize([trial, trial])

    def test_missing_markers_invalid_order_nan_and_missing_memory_fail(self):
        cases = []
        item = result(); del item['markers']['body']; cases.append(item)
        item = result(); item['markers']['body']['time_ns'] = 99; cases.append(item)
        item = result(); item['memory_peak']['rss_bytes'] = float('nan'); cases.append(item)
        item = result(); item['memory_peak'] = {}; cases.append(item)
        group = measure.summarize(cases)['groups'][0]
        self.assertEqual(group['failed'], 4)
        self.assertEqual(group['successful'], 0)

    def test_debug_missing_metadata_and_unknown_schema_rejected(self):
        item = result(); item['metadata']['app']['build'] = 'debug'
        with self.assertRaises(ValueError): measure.summarize([item])
        item = result(); del item['metadata']['environment']['power']
        with self.assertRaises(ValueError): measure.summarize([item])
        item = result(); item['schema'] = 3
        with self.assertRaises(ValueError): measure.summarize([item])


class MarkerTests(unittest.TestCase):
    def test_missing_marker_is_missing_not_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(measure.read_markers(Path(directory), 10, 30), {})

    def test_bounds_evidence_and_order(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            for bad in [{'time_ns': 9, 'evidence': 'frame'}, {'time_ns': 31, 'evidence': 'frame'},
                        {'time_ns': 20}, {'time_ns': True, 'evidence': 'frame'}]:
                measure.write_json(out / 'body.json', bad)
                with self.assertRaises(ValueError): measure.read_markers(out, 10, 30)
            measure.write_json(out / 'body.json', {'time_ns': 20, 'evidence': 'body frame'})
            measure.write_json(out / 'viewport.json', {'time_ns': 19, 'evidence': 'viewport frame'})
            with self.assertRaises(ValueError): measure.read_markers(out, 10, 30)
            measure.write_json(out / 'viewport.json', {'time_ns': 21, 'evidence': 'viewport frame'})
            self.assertEqual(len(measure.read_markers(out, 10, 30)), 2)


class TreeTests(unittest.TestCase):
    def fake_psutil(self):
        class Gone(Exception): pass
        class Denied(Exception): pass
        class Process:
            def __init__(self, pid):
                if pid not in nodes: raise Gone()
                self.pid = pid
            def create_time(self): return nodes[self.pid]['born']
            def children(self, recursive): return [Process(pid) for pid in nodes[self.pid]['children']]
            def name(self): return f'process-{self.pid}'
            def memory_info(self):
                if nodes[self.pid].get('denied'): raise Denied()
                return types.SimpleNamespace(rss=100, wset=100, private=200)
        nodes = {1: {'born': 1, 'children': [2]}, 2: {'born': 2, 'children': []}}
        return nodes, types.SimpleNamespace(Process=Process, NoSuchProcess=Gone, AccessDenied=Denied)

    def test_child_webview_included_and_retained_after_reparent(self):
        nodes, psutil = self.fake_psutil(); tracked = {}
        with patch.object(measure.sys, 'platform', 'win32'):
            sample = measure.sample_tree(psutil, {1: 1}, tracked)
            self.assertEqual(sample['totals'], {'working_set_bytes': 200, 'private_bytes': 400})
            nodes.pop(1)
            sample = measure.sample_tree(psutil, {1: 1}, tracked)
            self.assertEqual([p['pid'] for p in sample['processes']], [2])

    def test_pid_reuse_is_excluded(self):
        nodes, psutil = self.fake_psutil(); tracked = {2: 1}
        self.assertFalse(measure.sample_tree(psutil, {}, tracked)['complete'])
        self.assertNotIn(2, tracked)

    def test_access_denied_does_not_report_partial_memory_as_complete(self):
        nodes, psutil = self.fake_psutil(); nodes[2]['denied'] = True
        with patch.object(measure.sys, 'platform', 'linux'):
            sample = measure.sample_tree(psutil, {1: 1}, {})
        self.assertFalse(sample['complete'])
        self.assertEqual(sample['totals'], {})
        self.assertEqual(sample['errors'][0]['pid'], 2)


class IntegrationTests(unittest.TestCase):
    def test_real_process_sampler_cli_and_atomic_markers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / '日本語 test.md'; fixture.write_text('# artificial', encoding='utf-8')
            measure.write_json(root / 'metadata.json', metadata())
            out = root / 'trial'
            # The test host is the synthetic warm application's root.
            app = types.SimpleNamespace(pid=os.getpid())
            script = str(Path(measure.__file__).resolve())
            marker_code = (
                'import subprocess,sys; '
                '[subprocess.run([sys.executable,sys.argv[1],"mark","--out",sys.argv[2],'
                '"--stage",stage,"--evidence","synthetic-test-only"],check=True) '
                'for stage in ("body","viewport")]'
            )
            try:
                invocation = [sys.executable, script, 'record', '--metadata', str(root / 'metadata.json'),
                              '--fixture', str(fixture), '--out', str(out), '--mode', 'warm',
                              '--root-pid', str(app.pid), '--timeout', '10', '--',
                              sys.executable, '-c', marker_code, script, str(out), '{fixture}']
                completed = subprocess.run(invocation, capture_output=True, text=True, timeout=15)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                recorded = json.loads((out / 'result.json').read_text(encoding='utf-8'))
                self.assertEqual(recorded['status'], 'success')
                self.assertEqual(recorded['schema'], 2)
                self.assertEqual(recorded['argv'][-1], str(fixture.resolve()))
                self.assertTrue(Path(recorded['resolved_executable']).is_absolute())
                self.assertEqual(set(recorded['memory_peak']), set(recorded['memory_method']['metrics']))
                samples = [json.loads(line) for line in (out / 'samples.jsonl').read_text().splitlines()]
                self.assertTrue(any(p['pid'] == app.pid for s in samples for p in s['processes']))
                self.assertGreater(recorded['sample_count'], 0)
                self.assertTrue(all(value > 0 for value in recorded['memory_peak'].values()))
                duplicate = subprocess.run([sys.executable, script, 'mark', '--out', str(out),
                                            '--stage', 'body', '--evidence', 'replacement'],
                                           capture_output=True, timeout=10)
                self.assertNotEqual(duplicate.returncode, 0)
                self.assertEqual(json.loads((out / 'body.json').read_text())['evidence'],
                                 'synthetic-test-only')
                # Result files cannot be accidentally replaced by another trial.
                again = subprocess.run(invocation, capture_output=True, timeout=10)
                self.assertNotEqual(again.returncode, 0)
            finally:
                pass  # The synthetic root is this test process; never terminate it.

    def test_missing_render_marker_records_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); fixture = root / 'test.md'; fixture.write_text('# test')
            measure.write_json(root / 'meta.json', metadata())
            # The test host is the synthetic warm application's root.
            app = types.SimpleNamespace(pid=os.getpid())
            try:
                process = subprocess.run([sys.executable, measure.__file__, 'record',
                                          '--metadata', str(root / 'meta.json'), '--fixture', str(fixture),
                                          '--out', str(root / 'timeout'), '--mode', 'warm',
                                          '--root-pid', str(app.pid), '--timeout', '.2', '--',
                                          sys.executable, '-c', 'pass', '{fixture}'],
                                         capture_output=True, timeout=10)
                self.assertEqual(process.returncode, 1)
                record = json.loads((root / 'timeout/result.json').read_text())
                self.assertEqual(record['status'], 'failed')
                self.assertIn('timeout', record['reason'])
            finally:
                pass  # The synthetic root is this test process; never terminate it.


if __name__ == '__main__':
    unittest.main(verbosity=2)
