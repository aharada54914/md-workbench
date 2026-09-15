/** Resolve a document link lexically. This never creates filesystem authority;
 * the native broker validates the resulting path against existing grants. */
export function resolveDocumentLinkPath(documentPath: string | null, link: string): string {
  // Preserve native absolute spelling, including POSIX root and UNC prefixes.
  if (/^(?:[a-zA-Z]:|[/\\])/.test(link) || !documentPath) return link;
  const base = documentPath.replace(/\\/g, '/');
  const slash = base.lastIndexOf('/');
  if (slash < 0) return link;
  const joined = base.slice(0, slash + 1) + link.replace(/\\/g, '/');
  const root = joined.match(/^(?:[a-zA-Z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/)?.[0] ?? '';
  const parts: string[] = [];
  for (const part of joined.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (part !== '..' || !root) parts.push(part);
  }
  return root + (root && !root.endsWith('/') && parts.length ? '/' : '') + parts.join('/');
}
