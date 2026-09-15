import { readFile } from '@tauri-apps/plugin-fs';
import { markdownLanguage } from '@codemirror/lang-markdown';

function isAbsoluteImagePath(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.startsWith('/');
}

/**
 * Resolves a relative image path to an absolute file path.
 */
function resolveToAbsolutePath(src: string, baseDir: string): string {
  if (isAbsoluteImagePath(src)) {
    return src; // Already absolute
  }

  const absolutePath = `${baseDir.replace(/[\\/]+$/, '')}/${src}`.replace(/\\/g, '/');
  // Keep filesystem roots outside the dot-segment stack, including UNC share roots.
  const root = absolutePath.match(/^(?:[a-zA-Z]:\/|\/\/[^/]+\/[^/]+(?:\/|$)|\/)/)?.[0] ?? '';
  const parts = absolutePath.slice(root.length).split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      normalized.pop();
    } else if (part !== '.' && part !== '') {
      normalized.push(part);
    }
  }
  return root + normalized.join('/');
}

/**
 * Reads a local file and returns a blob URL.
 */
function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
  };
  return mimeMap[ext] || 'image/png';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fileToDataUri(absolutePath: string): Promise<string> {
  const bytes = await readFile(absolutePath);
  return `data:${mimeForPath(absolutePath)};base64,${bytesToBase64(bytes)}`;
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

/**
 * Inlines local image references in a markdown string as base64 data URIs.
 * Used for Marp export/preview where the rendered HTML lives in a sandboxed
 * iframe (srcdoc) with no base URL, so relative/local paths can't be fetched.
 * Remote (http/https), data: and blob: sources are left untouched.
 */
export async function inlineMarkdownImages(markdown: string, baseDir?: string, isCurrent: () => boolean = () => true): Promise<string> {
  if (!isCurrent()) return markdown;
  const matches = inlineImageSources(markdown);
  const replacements = new Map<string, string>();
  // Only share reads within this rendering request; document changes never reuse bytes.
  const reads = new Map<string, Promise<string>>();

  await Promise.all(
    matches.map(async (m) => {
      if (!isCurrent()) return;
      const src = m.src;
      if (replacements.has(src)) return;
      if (/^(data:|blob:|https?:)/i.test(src)) return;

      const isAbsolute = isAbsoluteImagePath(src);
      if (!isAbsolute && !baseDir) return;
      const absolutePath = isAbsolute ? src : resolveToAbsolutePath(src, baseDir!);

      try {
        let read = reads.get(absolutePath);
        if (!read) { read = fileToDataUri(absolutePath); reads.set(absolutePath, read); }
        const uri = await read;
        if (isCurrent()) replacements.set(src, uri);
      } catch (e) {
        if (!isCurrent()) return;
        console.warn(`[ImageResolver] Failed to inline image: ${absolutePath}`, e);
      }
    })
  );

  if (replacements.size === 0) return markdown;
  let result = '', from = 0;
  for (const image of matches) {
    const uri = replacements.get(image.src);
    if (!uri) continue;
    result += markdown.slice(from, image.from) + uri;
    from = image.to;
  }
  return result + markdown.slice(from);
}

/**
 * Extracts the directory from a file path.
 */
export function getDirectoryFromFilePath(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash === 0 ? filePath[0] : lastSlash > 0 ? filePath.substring(0, lastSlash) : '';
}
