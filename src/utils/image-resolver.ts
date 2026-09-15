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

type DisplayMutation = (apply: () => void) => void;
interface ImageDisplay {
  source: string;
  url?: string;
  pending?: Promise<void>;
  isCurrent?: () => boolean;
}

/** One owner per editor. No global or inactive image cache: only live nodes own URLs. */
export function createEditorImageResolver(mutate: DisplayMutation = apply => apply(), onRelease?: (url: string) => void) {
  let container: Element | undefined;
  let disposed = false;
  const displays = new Map<HTMLImageElement, ImageDisplay>();
  const observer = new MutationObserver(records => prune(records));

  function release(img: HTMLImageElement, display: ImageDisplay, restore = false) {
    if (displays.get(img) !== display) return;
    displays.delete(img);
    if (display.url) {
      onRelease?.(display.url);
      if (restore && img.getAttribute('src') === display.url) {
        mutate(() => img.setAttribute('src', display.source));
      }
      URL.revokeObjectURL(display.url);
    }
  }

  function prune(records: MutationRecord[] = []) {
    for (const [img, display] of displays) {
      const src = img.getAttribute('src');
      const removed = records.some(record => Array.from(record.removedNodes).some(node => node === img || node.contains(img)));
      const changedWhileReading = !display.url && records.some(record => record.type === 'attributes' && record.target === img);
      if (!container?.contains(img) || removed || changedWhileReading || src !== (display.url ?? display.source)) {
        release(img, display, true);
      }
    }
  }

  function reset() {
    observer.disconnect();
    for (const [img, display] of displays) release(img, display, true);
    container = undefined;
  }

  function dispose() { disposed = true; reset(); }

  async function resolve(root: Element, baseDir?: string, isCurrent: () => boolean = () => true): Promise<void> {
    if (disposed || !isCurrent() || !root.isConnected) return;
    if (container !== root) {
      reset(); container = root;
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }
    prune(observer.takeRecords());
    const images = root.querySelectorAll<HTMLImageElement>('img.editor-image');
    await Promise.all(Array.from(images).map(async img => {
      const previous = displays.get(img);
      if (previous?.url && img.getAttribute('src') === previous.url) return;
      if (previous?.pending && previous.isCurrent?.()) return previous.pending;
      if (previous) release(img, previous);
      const source = img.getAttribute('src') || '';
      if (!source || /^(blob:|data:|https?:)/i.test(source)) return;
      const absolute = isAbsoluteImagePath(source);
      if (!absolute && !baseDir) return;
      const absolutePath = absolute ? source : resolveToAbsolutePath(source, baseDir!);
      const display: ImageDisplay = { source };
      displays.set(img, display);
      const current = () => !disposed && isCurrent() && container === root && root.isConnected
        && root.contains(img) && displays.get(img) === display && img.getAttribute('src') === source;
      display.isCurrent = current;
      display.pending = (async () => {
        try {
          const bytes = await readFile(absolutePath);
          prune(observer.takeRecords());
          if (!current()) { release(img, display); return; }
          const url = URL.createObjectURL(new Blob([bytes], { type: mimeForPath(absolutePath) }));
          display.url = url;
          // The caller can suppress its model observer only for this synchronous display change.
          mutate(() => {
            img.setAttribute('data-original-src', source);
            img.setAttribute('src', url);
          });
        } catch (error) {
          const report = current();
          release(img, display);
          if (report) console.warn(`[ImageResolver] Failed to load image: ${absolutePath}`, error);
        }
      })();
      return display.pending;
    }));
  }
  return { resolve, reset, dispose };
}

/**
 * Extracts the directory from a file path.
 */
export function getDirectoryFromFilePath(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash === 0 ? filePath[0] : lastSlash > 0 ? filePath.substring(0, lastSlash) : '';
}
