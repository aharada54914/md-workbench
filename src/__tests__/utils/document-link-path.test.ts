import { describe, expect, it } from 'vitest';
import { resolveDocumentLinkPath } from '../../utils/document-link-path';

describe('document link path resolution', () => {
  it.each([
    ['/test/file.md', 'next.md', '/test/next.md'],
    ['/file.md', 'next.md', '/next.md'],
    ['/a/b/file.md', '../next.md', '/a/next.md'],
    ['/a/file.md', '../../next.md', '/next.md'],
    ['C:\\work\\file.md', 'next.md', 'C:/work/next.md'],
    ['C:/file.md', '../next.md', 'C:/next.md'],
    ['\\\\server\\share\\dir\\file.md', '../next.md', '//server/share/next.md'],
    ['//server/share/file.md', '../../next.md', '//server/share/next.md'],
    ['/test/file.md', '/other/file.md', '/other/file.md'],
    ['/test/file.md', 'D:\\other\\file.md', 'D:\\other\\file.md'],
    ['/test/file.md', 'D:/other/file.md', 'D:/other/file.md'],
    ['/test/file.md', '\\\\server\\share\\file.md', '\\\\server\\share\\file.md'],
    ['/test/file.md', '//server/share/file.md', '//server/share/file.md'],
    [null, 'relative.md', 'relative.md'],
  ])('resolves %s and %s without changing its root', (base, link, expected) => {
    expect(resolveDocumentLinkPath(base, link!)).toBe(expected);
  });
});
