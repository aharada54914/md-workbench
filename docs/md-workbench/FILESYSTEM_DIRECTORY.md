# Broker directory enumeration

T04 foundation, 2026-09-16. This host API is not yet wired to the workspace UI;
legacy workspace commands and broad filesystem permissions remain to be migrated.

`FileAccess::list_directory(window, id, relative, limit)` requires the caller's
live READ grant for a Workspace or Resource directory. An exact document/export
grant cannot enumerate its parent. An empty relative path lists the selected
root; nested paths use the same portable path policy as broker reads.

Each directory component is opened with `open_dir_nofollow` through the retained
handle. Enumeration uses [cap-std 4.0.3 DirEntry](https://docs.rs/cap-std/4.0.3/cap_std/fs/struct.DirEntry.html)
names and file types, without constructing or reopening an ambient absolute path.
Rows contain only a child name and directory flag. They are routing metadata;
subsequent operations must reauthorize and open their target safely.

The API returns direct children, directories first and then lexicographic names.
Links, special files and names rejected by the portable path policy are excluded
and counted in `omitted`, so callers can disclose incomplete listings. It scans
at most the requested limit plus one overflow witness, with a ceiling of 10,000.
Overflow rejects the operation instead of reporting a partial list as complete.
Enumeration errors also reject. This API neither grants authority nor writes files.

Six native macOS tests pass: direct/nested Unicode listings; READ ownership,
revocation and exact-file bounds; traversal rejection; entry limits; omitted links
and nonportable names; and retained authority after a selected directory is replaced
with an outside symlink. Linux additionally exercises a real non-UTF-8 filename;
APFS rejects such names at fixture creation. Windows additionally exercises a real
junction. Those OS-specific tests await CI execution. Coverage was not measured.
