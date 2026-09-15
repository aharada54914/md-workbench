"""Public libproc contracts; real tests use only synthetic processes."""
import ctypes
import errno
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import macos_memory


class AdapterTests(unittest.TestCase):
    def test_exact_uint64_values_and_native_identity(self):
        def call(pid, flavor, pointer):
            self.assertEqual((pid, flavor), (42, 0))
            value = ctypes.cast(pointer, ctypes.POINTER(macos_memory.RusageInfoV0)).contents
            value.ri_phys_footprint = 2**63 + 17
            value.ri_proc_start_abstime = 91
            return 0
        with patch.object(macos_memory, '_load_function', return_value=call):
            value = macos_memory.read_footprint(42)
        self.assertEqual(value['physical_footprint_bytes'], 2**63 + 17)
        self.assertEqual(value['native_start_abstime'], 91)
        self.assertEqual(value['native_exit_abstime'], 0)

    def test_errno_and_unavailable_are_not_zero(self):
        def denied(*args):
            ctypes.set_errno(errno.EPERM)
            return -1
        with patch.object(macos_memory, '_load_function', return_value=denied):
            with self.assertRaises(macos_memory.FootprintError) as caught:
                macos_memory.read_footprint(42)
        self.assertEqual(caught.exception.code, errno.EPERM)
        with patch.object(macos_memory, '_load_function', side_effect=OSError('missing')):
            with self.assertRaises(macos_memory.FootprintError) as caught:
                macos_memory.read_footprint(42)
        self.assertEqual(caught.exception.reason, 'footprint-api-unavailable')

    def test_invalid_pid_rejected_before_ffi(self):
        with patch.object(macos_memory, '_load_function') as load:
            for pid in [True, 0, -1, 2**31, '1']:
                with self.assertRaises(ValueError): macos_memory.read_footprint(pid)
            load.assert_not_called()


@unittest.skipUnless(sys.platform == 'darwin', 'public libproc requires macOS')
class NativeTests(unittest.TestCase):
    def test_sdk_abi_matches_ctypes(self):
        source = r'''#include <sys/resource.h>
#include <stddef.h>
#include <stdio.h>
int main(void) {
 printf("%zu %zu %zu %zu\n", sizeof(struct rusage_info_v0),
 offsetof(struct rusage_info_v0, ri_phys_footprint),
 offsetof(struct rusage_info_v0, ri_proc_start_abstime),
 offsetof(struct rusage_info_v0, ri_proc_exit_abstime));
}'''
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'abi.c').write_text(source)
            subprocess.run(['xcrun', 'clang', '-Wall', '-Werror', str(root / 'abi.c'), '-o', str(root / 'abi')],
                           check=True, capture_output=True, timeout=30)
            measured = list(map(int, subprocess.check_output([str(root / 'abi')], timeout=5).split()))
        layout = macos_memory.RusageInfoV0
        self.assertEqual(measured, [ctypes.sizeof(layout), layout.ri_phys_footprint.offset,
                                   layout.ri_proc_start_abstime.offset, layout.ri_proc_exit_abstime.offset])

    def test_self_and_explicit_synthetic_child(self):
        own = macos_memory.read_footprint(os.getpid())
        self.assertGreater(own['physical_footprint_bytes'], 0)
        code = ('import sys,json; from macos_memory import read_footprint; import os; '
                'data=bytearray(4*1024*1024); '
                'print(json.dumps(read_footprint(os.getpid())),flush=True); sys.stdin.read(1)')
        child = subprocess.Popen([sys.executable, '-c', code], cwd=Path(__file__).parent,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            ready, _, _ = select.select([child.stdout], [], [], 10)
            self.assertTrue(ready, 'synthetic child did not become ready')
            inside = json.loads(child.stdout.readline())
            outside = macos_memory.read_footprint(child.pid)
            self.assertEqual(inside['native_start_abstime'], outside['native_start_abstime'])
            self.assertGreater(outside['physical_footprint_bytes'], 0)
            self.assertEqual(outside['native_exit_abstime'], 0)
        finally:
            child.communicate(input='x', timeout=10)
        self.assertEqual(child.returncode, 0)
        with self.assertRaises(macos_memory.FootprintError): macos_memory.read_footprint(child.pid)


if __name__ == '__main__':
    unittest.main(verbosity=2)
