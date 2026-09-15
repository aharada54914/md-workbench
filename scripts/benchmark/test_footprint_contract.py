import errno
import unittest
from unittest.mock import patch

import measure
from macos_memory import FootprintError
import test_measure
from test_measure import result


def native(start=10, exited=0):
    return {'physical_footprint_bytes': 300, 'native_start_abstime': start,
            'native_exit_abstime': exited}


class FootprintTreeTests(unittest.TestCase):
    def setUp(self):
        self.nodes, self.psutil = test_measure.TreeTests().fake_psutil()
        self.platform = patch.object(measure.sys, 'platform', 'darwin')
        self.platform.start()
        self.addCleanup(self.platform.stop)

    def sample(self, reader, starts=None):
        return measure.sample_tree(self.psutil, {1: 1}, {},
                                   footprint_reader=reader, native_starts=starts)

    def test_success_keeps_rss_distinct_and_sums_native_bytes(self):
        sample = self.sample(lambda pid: native(pid * 10))
        self.assertTrue(sample['complete'])
        self.assertEqual(sample['totals'], {'rss_bytes': 200, 'summed_physical_footprint_bytes': 600})

    def test_denial_and_unavailability_preserve_rows_but_no_partial_total(self):
        for reason, code in [('footprint-read-failed', errno.EPERM), ('footprint-api-unavailable', None)]:
            def reader(pid):
                if pid == 2: raise FootprintError(reason, code)
                return native()
            sample = self.sample(reader)
            self.assertFalse(sample['complete'])
            self.assertEqual(sample['totals'], {})
            self.assertEqual(len(sample['processes']), 2)
            self.assertNotIn('physical_footprint_bytes', sample['processes'][1])
            self.assertEqual(sample['errors'], [{'pid': 2, 'reason': reason, 'errno': code}])

    def test_native_identity_change_exit_and_psutil_reuse_rejected(self):
        starts = {}
        self.assertTrue(self.sample(lambda pid: native(pid), starts)['complete'])
        self.assertFalse(self.sample(lambda pid: native(pid + 1), starts)['complete'])
        self.assertFalse(self.sample(lambda pid: native(pid, 12))['complete'])
        def reuse(pid):
            self.nodes[pid]['born'] += 1
            return native(pid)
        sample = self.sample(reuse)
        self.assertFalse(sample['complete'])
        self.assertEqual(sample['totals'], {})

    def test_disappearance_after_read_is_missing(self):
        def reader(pid):
            self.nodes.pop(pid)
            return native(pid)
        sample = self.sample(reader)
        self.assertFalse(sample['complete'])
        self.assertEqual(sample['totals'], {})

    def test_rediscovery_cannot_replace_a_tracked_pid_identity(self):
        tracked = {2: 1}
        sample = measure.sample_tree(self.psutil, {1: 1}, tracked,
                                     footprint_reader=lambda pid: native(pid))
        self.assertEqual([row['pid'] for row in sample['processes']], [1])
        self.assertNotIn(2, tracked)
        self.assertFalse(sample['complete'])

    def test_first_sample_with_reused_root_and_live_root_is_incomplete(self):
        self.nodes[1]['children'] = []
        sample = measure.sample_tree(self.psutil, {1: 99, 2: 2}, {},
                                     footprint_reader=lambda pid: native(pid))
        self.assertEqual([row['pid'] for row in sample['processes']], [2])
        self.assertFalse(sample['complete'])
        self.assertEqual(sample['totals'], {})
        self.assertEqual(sample['errors'], [{'pid': 1, 'reason': 'root-process-identity-changed'}])

    def test_later_missing_metric_does_not_erase_peaks_or_raise(self):
        good = self.sample(lambda pid: native(pid))
        bad = self.sample(lambda pid: native(pid, 1))
        self.assertEqual(measure.memory_peaks([good, bad]), good['totals'])
        self.assertEqual(measure.memory_peaks([bad]), {})


class MethodSummaryTests(unittest.TestCase):
    def modern(self):
        item = result()
        item.update(schema=2, memory_method={'id': 'libproc-rusage-v0', 'version': 1,
                    'flavor': 0, 'metrics': ['rss_bytes', 'summed_physical_footprint_bytes']},
                    sample_interval_s=.1, architecture='arm64', argv=['synthetic-app', 'fixture'],
                    resolved_executable='/synthetic/app')
        item['memory_peak']['summed_physical_footprint_bytes'] = 80
        return item

    def test_legacy_method_interval_and_architecture_groups_stay_separate(self):
        items = [result(), self.modern()]
        for field, value in [('sample_interval_s', .2), ('architecture', 'x86_64')]:
            item = self.modern(); item[field] = value; items.append(item)
        item = self.modern(); item['memory_method']['id'] = 'different-method'; items.append(item)
        self.assertEqual(len(measure.summarize(items)['groups']), 5)

    def test_missing_footprint_is_failed_not_rss_success(self):
        item = self.modern(); del item['memory_peak']['summed_physical_footprint_bytes']
        group = measure.summarize([item])['groups'][0]
        self.assertEqual(group['failed'], 1)
        self.assertEqual(group['successful'], 0)
        self.assertIsNone(group['metrics']['body_ms']['p50'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
