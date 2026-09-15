"""Public libproc physical-footprint observation; no privilege or RSS fallback."""
import ctypes
from functools import lru_cache


class RusageInfoV0(ctypes.Structure):
    _fields_ = [('ri_uuid', ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64) for name in (
            'ri_user_time', 'ri_system_time', 'ri_pkg_idle_wkups',
            'ri_interrupt_wkups', 'ri_pageins', 'ri_wired_size', 'ri_resident_size',
            'ri_phys_footprint', 'ri_proc_start_abstime', 'ri_proc_exit_abstime')]


class FootprintError(Exception):
    def __init__(self, reason, code=None):
        self.reason, self.code = reason, code
        super().__init__(reason)


@lru_cache(maxsize=1)
def _load_function():
    library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    function = library.proc_pid_rusage
    function.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    function.restype = ctypes.c_int
    return function


def read_footprint(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or not 0 < pid < 2**31:
        raise ValueError('pid must be a positive signed 32-bit integer')
    try:
        function = _load_function()
    except (OSError, AttributeError) as error:
        raise FootprintError('footprint-api-unavailable') from error
    info = RusageInfoV0()
    ctypes.set_errno(0)
    if function(pid, 0, ctypes.byref(info)) != 0:
        raise FootprintError('footprint-read-failed', ctypes.get_errno())
    return {'physical_footprint_bytes': info.ri_phys_footprint,
            'native_start_abstime': info.ri_proc_start_abstime,
            'native_exit_abstime': info.ri_proc_exit_abstime}
