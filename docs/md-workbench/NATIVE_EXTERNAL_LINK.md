# Native external browser links

Document links keep the existing confirmation dialog. Settings links and confirmed
HTTP(S) links call `native_open_external_link` with the URL only. The global native
invoke gate requires the actual registered editor WebView; the command captures
its generation and checks it again under the registration lock before OS dispatch.
A closed or recreated window cannot reuse the queued request.

Native URL validation limits input to 8192 UTF-8 bytes, requires a complete HTTP(S)
authority and rejects credentials, whitespace, controls and backslashes. File,
JavaScript, data, mail and executable targets are rejected. Windows dispatch uses
ShellExecuteW with a fixed open verb and no parameters, after successful STA COM
initialization on that worker thread with balanced teardown; macOS uses /usr/bin/open
with one URL argument; Linux uses xdg-open with one URL argument. No command
interpreter or caller-selected program is involved. This is browser dispatch,
not proof that a browser navigated successfully or a restriction on later redirects.
Unix opener processes are reaped on a detached blocking task after the native
registration lock is released. Settings show a localized dispatch-failure alert.

The renderer shell:allow-open capability is removed. The shell plugin remains
installed for existing diagnostic ACL checks, but no product renderer imports it.
This boundary does not remove the remaining filesystem capabilities or complete T04.

Verification: native URL and generation rejection tests passed, including no
launcher calls for invalid inputs. The service preserves native rejection; the
existing file-operation suite passed. A Chromium test verifies zero dispatch
before document-link confirmation and the exact HTTP(S) URL afterward. The browser
test mocks native dispatch. Actual browser launch on Windows/Linux remains an OS
integration check; local Windows cross-compilation of the full app was unavailable
because the MinGW C compiler is missing. The actual platform-launch function was
separately compiled for Windows GNU with the same windows-sys version/features;
this verifies API signatures, not browser behavior. After review corrections,
96 scoped frontend tests, two native tests and type checking passed. Independent
review found no remaining Critical/Warning in this slice.
