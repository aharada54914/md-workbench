"""Run CI diagnostics at medium integrity without admin SIDs/privileges.

This only drops privileges. It never changes OS/Edge policy, user accounts,
ACLs, registry, or enables SANDBOX_INERT. Not a general security sandbox.
"""
import ctypes as c
from ctypes import wintypes as w
import os
import shutil
import subprocess
import sys

if sys.platform != 'win32' or os.getenv('GITHUB_ACTIONS') != 'true' or os.getenv('RUNNER_ENVIRONMENT') != 'github-hosted':
    raise RuntimeError('Disposable GitHub-hosted Windows only')

k = c.WinDLL('kernel32', use_last_error=True)
a = c.WinDLL('advapi32', use_last_error=True)

class SidAttributes(c.Structure):
    _fields_ = [('Sid', c.c_void_p), ('Attributes', w.DWORD)]

class StartupInfo(c.Structure):
    _fields_ = [('cb', w.DWORD), ('reserved', w.LPWSTR), ('desktop', w.LPWSTR), ('title', w.LPWSTR),
                ('x', w.DWORD), ('y', w.DWORD), ('width', w.DWORD), ('height', w.DWORD),
                ('chars_x', w.DWORD), ('chars_y', w.DWORD), ('fill', w.DWORD), ('flags', w.DWORD),
                ('show', w.WORD), ('reserved_size', w.WORD), ('reserved_bytes', c.c_void_p),
                ('stdin', w.HANDLE), ('stdout', w.HANDLE), ('stderr', w.HANDLE)]

class ProcessInfo(c.Structure):
    _fields_ = [('process', w.HANDLE), ('thread', w.HANDLE), ('pid', w.DWORD), ('tid', w.DWORD)]

def bind(dll, name, args, result=w.BOOL):
    fn = getattr(dll, name)
    fn.argtypes, fn.restype = args, result
    return fn

current = bind(k, 'GetCurrentProcess', [], w.HANDLE)
close = bind(k, 'CloseHandle', [w.HANDLE])
local_free = bind(k, 'LocalFree', [c.c_void_p], c.c_void_p)
open_token = bind(a, 'OpenProcessToken', [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)])
restrict = bind(a, 'CreateRestrictedToken', [w.HANDLE, w.DWORD, w.DWORD, c.POINTER(SidAttributes), w.DWORD, c.c_void_p, w.DWORD, c.c_void_p, c.POINTER(w.HANDLE)])
sid_from_string = bind(a, 'ConvertStringSidToSidW', [w.LPCWSTR, c.POINTER(c.c_void_p)])
sid_size = bind(a, 'GetLengthSid', [c.c_void_p], w.DWORD)
set_token = bind(a, 'SetTokenInformation', [w.HANDLE, c.c_int, c.c_void_p, w.DWORD])
get_token = bind(a, 'GetTokenInformation', [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)])
sid_count = bind(a, 'GetSidSubAuthorityCount', [c.c_void_p], c.POINTER(c.c_ubyte))
sid_part = bind(a, 'GetSidSubAuthority', [c.c_void_p, w.DWORD], c.POINTER(w.DWORD))
create = bind(a, 'CreateProcessAsUserW', [w.HANDLE, w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD, c.c_void_p, w.LPCWSTR, c.POINTER(StartupInfo), c.POINTER(ProcessInfo)])
std_handle = bind(k, 'GetStdHandle', [w.DWORD], w.HANDLE)
inherit = bind(k, 'SetHandleInformation', [w.HANDLE, w.DWORD, w.DWORD])
wait = bind(k, 'WaitForSingleObject', [w.HANDLE, w.DWORD], w.DWORD)
exit_code = bind(k, 'GetExitCodeProcess', [w.HANDLE, c.POINTER(w.DWORD)])

def checked(ok):
    if not ok:
        raise c.WinError(c.get_last_error())

def assert_limited(token):
    elevation, size = w.DWORD(), w.DWORD()
    checked(get_token(token, 20, c.byref(elevation), c.sizeof(elevation), c.byref(size)))
    get_token(token, 25, None, 0, c.byref(size))
    info = c.create_string_buffer(size.value)
    checked(get_token(token, 25, info, size, c.byref(size)))
    sid = c.cast(info, c.POINTER(SidAttributes)).contents.Sid
    integrity = sid_part(sid, sid_count(sid)[0] - 1)[0]
    if elevation.value or integrity != 0x2000:
        raise RuntimeError(f'Refusing non-medium/elevated token: elevation={elevation.value} integrity={integrity}')
    print(f'CI token verified: elevated=0 integrity={integrity} (medium)', flush=True)

original, limited = w.HANDLE(), w.HANDLE()
admin, medium = c.c_void_p(), c.c_void_p()
child = ProcessInfo()
try:
    verify_only = sys.argv[1:] == ['--verify']
    # The child only reads its state; it must not request token modification.
    access = 0x0008 if verify_only else 0x000B | 0x0080
    checked(open_token(current(), access, c.byref(original)))
    if verify_only:
        assert_limited(original)
        sys.exit(0)
    if len(sys.argv) < 2:
        raise RuntimeError('Usage: run_limited.py COMMAND [ARGS]')
    checked(sid_from_string('S-1-5-32-544', c.byref(admin)))
    deny_admin = SidAttributes(admin, 0)
    checked(restrict(original, 0x1 | 0x4, 1, c.byref(deny_admin), 0, None, 0, None, c.byref(limited)))
    checked(sid_from_string('S-1-16-8192', c.byref(medium)))
    label = SidAttributes(medium, 0x20)
    checked(set_token(limited, 25, c.byref(label), c.sizeof(label) + sid_size(medium)))
    assert_limited(limited)
    executable = shutil.which(sys.argv[1])
    if not executable:
        raise RuntimeError('Executable not found')
    command = c.create_unicode_buffer(subprocess.list2cmdline([executable, *sys.argv[2:]]))
    startup = StartupInfo()
    startup.cb, startup.flags = c.sizeof(startup), 0x100
    for name, number in [('stdin', -10), ('stdout', -11), ('stderr', -12)]:
        handle = std_handle(number & 0xFFFFFFFF)
        checked(inherit(handle, 1, 1))
        setattr(startup, name, handle)
    checked(create(limited, executable, command, None, None, True, 0, None, os.getcwd(), c.byref(startup), c.byref(child)))
    if wait(child.process, 25 * 60 * 1000) != 0:
        subprocess.run(['taskkill.exe', '/PID', str(child.pid), '/T', '/F'], check=True)
        raise RuntimeError('Limited diagnostic timeout')
    result = w.DWORD()
    checked(exit_code(child.process, c.byref(result)))
    sys.exit(result.value)
finally:
    for handle in [child.thread, child.process, limited, original]:
        if handle:
            close(handle)
    for sid in [medium, admin]:
        if sid:
            local_free(sid)
