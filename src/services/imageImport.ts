import { copyFile, mkdir, exists, writeFile } from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { getDirectoryFromFilePath } from '../utils/image-resolver';
import { splitFilename, toForwardSlashes } from '../utils/image-file-utils';
import { nativeFs } from './nativeFs';

const IMAGES_DIR = 'images';
/** Where images dropped/pasted into an unsaved document are parked. */
const UNSAVED_IMAGES_DIR = 'unsaved-images';

/**
 * Stable app-managed folder for images added before the document has a path.
 * Returns an absolute, forward-slashed directory (created if missing) so the
 * markdown references a real file link instead of an inline data: URL — which
 * otherwise dumped a huge base64 blob into the code view.
 */
async function getUnsavedImagesDir(): Promise<string> {
  const base = toForwardSlashes(await appDataDir()).replace(/\/+$/, '');
  const dir = `${base}/${UNSAVED_IMAGES_DIR}`;
  await mkdir(dir, { recursive: true });
  return dir;
}

export interface ImportedImage {
  /** Path to use inside markdown — relative when copied, absolute when doc unsaved. */
  markdownPath: string;
  /** Alt text suggestion derived from filename (without extension). */
  altText: string;
}

export interface ImageImportSelection {
  expectedGrantId: string;
  isCurrent: () => boolean;
}

function assertCurrent(selection?: ImageImportSelection): void {
  if (selection && !selection.isCurrent()) {
    throw new DOMException('Image drop is no longer current', 'AbortError');
  }
}

/**
 * Imports a dropped image. If the host document is saved, copies the image into
 * `<docDir>/images/` (creating the directory + resolving name collisions) and
 * returns a relative path. Otherwise returns the absolute source path.
 */
export async function importImage(
  srcPath: string,
  docPath: string | null,
  selection?: ImageImportSelection,
): Promise<ImportedImage> {
  assertCurrent(selection);
  // Validate the OS selection even when an unsaved document keeps a source link.
  const sourceBytes = selection
    ? await nativeFs.readPathBytes(srcPath, undefined, selection.expectedGrantId)
    : undefined;
  assertCurrent(selection);
  const { stem, ext } = splitFilename(srcPath);
  const altText = stem;

  if (!docPath) {
    return { markdownPath: toForwardSlashes(srcPath), altText };
  }

  const docDir = getDirectoryFromFilePath(docPath);
  if (!docDir) {
    return { markdownPath: toForwardSlashes(srcPath), altText };
  }

  const targetDir = `${docDir}/${IMAGES_DIR}`;
  await mkdir(targetDir, { recursive: true });
  assertCurrent(selection);

  const finalName = await resolveCollision(targetDir, stem, ext, selection);
  assertCurrent(selection);
  const targetPath = `${targetDir}/${finalName}`;

  if (sourceBytes) await writeFile(targetPath, sourceBytes);
  else await copyFile(srcPath, targetPath);
  assertCurrent(selection);

  return {
    markdownPath: `${IMAGES_DIR}/${finalName}`,
    altText,
  };
}

/**
 * Imports raw image bytes (e.g. from clipboard paste). Writes the bytes into
 * `<docDir>/images/` with collision-safe naming and returns the markdown path.
 * Falls back to a data: URL if the document is unsaved (no anchor directory).
 */
export async function importImageBytes(
  bytes: Uint8Array,
  ext: string,
  docPath: string | null,
  stemHint: string = 'pasted-image',
): Promise<ImportedImage> {
  const stem = `${stemHint}-${Date.now()}`;
  const docDir = docPath ? getDirectoryFromFilePath(docPath) : null;

  // Unsaved document (no anchor directory): park the image in the app's
  // managed folder and reference it by absolute path. Falls back to a data:
  // URL only if even that write fails, so the image still shows.
  if (!docDir) {
    try {
      const dir = await getUnsavedImagesDir();
      const finalName = await resolveCollision(dir, stem, ext);
      const targetPath = `${dir}/${finalName}`;
      await writeFile(targetPath, bytes);
      return { markdownPath: targetPath, altText: stem };
    } catch {
      const blob = new Blob([bytes], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` });
      const dataUrl = await blobToDataUrl(blob);
      return { markdownPath: dataUrl, altText: stem };
    }
  }

  const targetDir = `${docDir}/${IMAGES_DIR}`;
  await mkdir(targetDir, { recursive: true });
  const finalName = await resolveCollision(targetDir, stem, ext);
  const targetPath = `${targetDir}/${finalName}`;

  await writeFile(targetPath, bytes);

  return { markdownPath: `${IMAGES_DIR}/${finalName}`, altText: stem };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function resolveCollision(
  dir: string,
  stem: string,
  ext: string,
  selection?: ImageImportSelection,
): Promise<string> {
  const available = async (name: string) => {
    assertCurrent(selection);
    const found = await exists(`${dir}/${name}`);
    assertCurrent(selection);
    return !found;
  };
  const suffix = ext ? `.${ext}` : '';
  const initial = `${stem}${suffix}`;
  if (await available(initial)) return initial;

  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem} (${i})${suffix}`;
    if (await available(candidate)) return candidate;
  }

  return `${stem}-${Date.now()}${suffix}`;
}
