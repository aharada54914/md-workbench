# Windows storage API observations

Measured by [CI run 35001120164](https://github.com/aharada54914/md-workbench/actions/runs/35001120164)
on 2026-09-15 UTC. PR head: `e19cd74f4e9ccde0139374a1dfbf9edb59135b2e`;
tested PR merge: `ea808e778b3dfd8224ea9b2bccaf08c4c2118807`.
These JSON files are copied unchanged from the run artifacts.

| Observation | Windows Server 2022 x64 | Windows 11 ARM |
| --- | --- | --- |
| Filesystem | NTFS | NTFS |
| Read-only directory FlushFileBuffers | Error 5 (access denied) | Error 5 (access denied) |
| Read/write directory open | Success | Success |
| File write and flush | Success | Success |
| Read/write child-directory flush | Success | Success |
| Read/write parent-directory flush | Success | Success |
| Fixture cleanup | Success | Success |

The explicit directory handles requested GENERIC_READ | GENERIC_WRITE, shared
READ | WRITE without DELETE, with BACKUP_SEMANTICS | OPEN_REPARSE_POINT. The
read-only baseline used cap-std's directory open. All seven probe schema tests
passed on both runners before observation.

This supports using explicitly writable directory handles for subsequent native
NTFS persistence work. It does not prove power-loss durability, arbitrary network
or non-NTFS support, ownership/ACL isolation, application journal ordering, or
recovery. A process crash test is also different from a power-loss test.
The probe did not modify product Save behavior.
