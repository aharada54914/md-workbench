import { markdownLanguage } from '@codemirror/lang-markdown';
import { documentImageBytes, IMAGE_BYTE_LIMIT, type ImageDocumentOwner } from '../services/documentImageBytes';
import { imageMime } from '../services/documentImageFormat';
import { nativeFs } from '../services/nativeFs';

export interface MarkdownImageContext {
  owner: ImageDocumentOwner | undefined;
  path: string | null;
  revision: number;
}
export interface InlinedMarkdown {
  markdown: string;
  /** Release only after the rendered output has been removed or replaced. */
  release(): void;
}
// UTF-16 output payload accounting; JSON, transient encoding copies and decoded
// pixels are not a total heap bound. A native read reserves another 8 MiB.
export const INLINE_REQUEST_BYTES = 64 * 1024 * 1024;
export const INLINE_WINDOW_BYTES = 128 * 1024 * 1024;
export const INLINE_REQUEST_IMAGES = 128;
export const INLINE_WINDOW_IMAGES = 256;
export const INLINE_CONCURRENT_REQUESTS = 4;
const MAX_PATH_LENGTH = 4096;
let windowBytes = 0;
let windowImages = 0;
let activeRequests = 0;

function localReference(source: string, documentPath: string | null): boolean {
  if (!documentPath || !source || source.length > MAX_PATH_LENGTH || /[\\\x00-\x20:?#]/.test(source)) return false;
  const parts = source.split('/');
  if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..')) return false;
  const file = documentPath.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return parts[0] === 'images' || parts[0] === `${stem}.assets`;
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function inlineImageSources(markdown: string): Array<{ from: number; to: number; src: string }> {
  const images: Array<{ from: number; to: number; src: string }> = [];
  // Use the same source-offset parser as resource-document; no serialization or code masking.
  const tree = markdownLanguage.parser.parse(markdown.startsWith('\uFEFF') ? ' ' + markdown.slice(1) : markdown);
  tree.iterate({ enter(node) {
    if (node.name !== 'Image') return;
    const url = node.node.getChild('URL');
    // Keep the existing direct-destination syntax. Reference resolution and decoding are separate work.
    const match = /^!\[([^\]]*)\]\(\s*([^)\s]+)((?:\s+"[^"]*")?)\s*\)$/.exec(markdown.slice(node.from, node.to));
    if (url && match && markdown.slice(url.from, url.to) === match[2]) {
      images.push({ from: url.from, to: url.to, src: match[2] });
    }
    return false; // Nested syntax in an image's alt text is not another rendered image.
  } });
  return images;
}

/** Only exact recognized destination spans change. Unavailable and unknown
 * syntax remains source text; every Marp rendering sink must separately block
 * its URLs (including CSS/reference/raw HTML) before browser publication.
 * No renderer path, URL or record metadata grants filesystem authority. */
export async function inlineMarkdownImages(
  markdown: string, context: MarkdownImageContext, isCurrent: () => boolean = () => true,
): Promise<InlinedMarkdown | undefined> {
  const { owner, path, revision } = context;
  const current = () => isCurrent() && !!owner && documentImageBytes.isCurrent(owner)
    && context.owner === owner && context.path === path && context.revision === revision;
  let reservedBytes = markdown.length * 2;
  if (!current() || reservedBytes > INLINE_REQUEST_BYTES || windowBytes + reservedBytes > INLINE_WINDOW_BYTES
    || activeRequests >= INLINE_CONCURRENT_REQUESTS) return undefined;
  const matches = inlineImageSources(markdown);
  if (matches.length > INLINE_REQUEST_IMAGES || windowImages + matches.length > INLINE_WINDOW_IMAGES) return undefined;
  const count = matches.length;
  windowBytes += reservedBytes;
  windowImages += count;
  activeRequests += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    windowBytes -= reservedBytes;
    windowImages -= count;
  };
  const replacements = new Map<string, string>();
  const occurrences = new Map<string, number>();
  for (const match of matches) occurrences.set(match.src, (occurrences.get(match.src) ?? 0) + 1);
  let descriptor: Awaited<ReturnType<typeof nativeFs.resolveDocumentReadGrant>> | undefined;
  let outputBytes = reservedBytes;
  let returned = false;
  try {
    // Sequential reads per request, at most four active requests across the
    // renderer. Invalidating a caller never frees an unresolved native slot.
    for (const [source, copies] of occurrences) {
      if (!current()) return undefined;
      if (source.length > MAX_PATH_LENGTH || /^(?:https?|data|blob|file):/i.test(source)) continue;
      if (windowBytes + IMAGE_BYTE_LIMIT > INLINE_WINDOW_BYTES) continue;
      windowBytes += IMAGE_BYTE_LIMIT;
      try {
        let bytes = documentImageBytes.read(owner!, source);
        if (!bytes) {
          if (!localReference(source, path)) continue;
          descriptor ??= await nativeFs.resolveDocumentReadGrant(path!);
          if (!current()) return undefined;
          bytes = await nativeFs.readDocumentImageBytes(path!, descriptor.grantId, source);
        }
        if (!current()) return undefined;
        const mime = imageMime(bytes);
        const header = `data:${mime};base64,`;
        const uriLength = header.length + Math.ceil(bytes.length / 3) * 4;
        // Every duplicate occurrence expands output even when its read is shared.
        const growth = Math.max(0, (uriLength - source.length) * copies * 2);
        if (outputBytes + growth > INLINE_REQUEST_BYTES || windowBytes + growth > INLINE_WINDOW_BYTES) continue;
        reservedBytes += growth;
        windowBytes += growth;
        outputBytes += growth;
        replacements.set(source, header + bytesToBase64(bytes));
      } catch {
        // A denied, revoked, absent or invalid image stays source text. Never
        // retry through plugin-fs, fetch, URL decoding or an alternate grant.
      } finally { windowBytes -= IMAGE_BYTE_LIMIT; }
    }
    if (!current()) return undefined;
    let result = '', from = 0;
    for (const image of matches) {
      const uri = replacements.get(image.src);
      if (!uri) continue;
      result += markdown.slice(from, image.from) + uri;
      from = image.to;
    }
    const lease = { markdown: result + markdown.slice(from), release };
    // Keep the output budget alive until its consumer drops the rendered string.
    returned = true;
    return lease;
  } finally {
    activeRequests -= 1;
    if (!returned) release();
  }
}

/** Display/path metadata helper; never an authorization or filesystem read. */
export function getDirectoryFromFilePath(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash === 0 ? filePath[0]! : lastSlash > 0 ? filePath.substring(0, lastSlash) : '';
}
