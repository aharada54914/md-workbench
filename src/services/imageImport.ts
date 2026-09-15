import { copyFile, mkdir, exists, writeFile } from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { getDirectoryFromFilePath } from '../utils/image-resolver';
import { splitFilename, toForwardSlashes } from '../utils/image-file-utils';
import { nativeFs } from './nativeFs';
import { documentImageBytes, IMAGE_BYTE_LIMIT, type ImageDocumentOwner, type PreparedDocumentImage } from './documentImageBytes';

const IMAGES_DIR = 'images';
/** Where images dropped/pasted into an unsaved document are parked. */
const UNSAVED_IMAGES_DIR = 'unsaved-images';

/**
 * Stable app-managed folder for images added before the document has a path.
 * Returns an absolute, forward-slashed directory (created if missing) so the
 * markdown references a real file link instead of an inline data: URL — which
 * otherwise dumped a huge base64 blob into the code view.
 */
async function getUnsavedImagesDir(context?: ImageImportContext): Promise<string> {
  assertCurrent(context);
  const base = toForwardSlashes(await appDataDir()).replace(/\/+$/, '');
  assertCurrent(context);
  const dir = `${base}/${UNSAVED_IMAGES_DIR}`;
  await mkdir(dir, { recursive: true });
  return dir;
}

export interface ImportedImage {
  /** Path to use inside markdown — relative when copied, absolute when doc unsaved. */
  markdownPath: string;
  /** Alt text suggestion derived from filename (without extension). */
  altText: string;
  /** Uncommitted current-document snapshot; consumer must commit or release. */
  prepared?: PreparedDocumentImage;
}

export interface ImageImportContext {
  owner?: ImageDocumentOwner;
  isCurrent: () => boolean;
}
export interface ImageImportSelection extends ImageImportContext {
  expectedGrantId: string;
}

function assertCurrent(selection?: ImageImportContext): void {
  if (selection && (!selection.isCurrent() || (selection.owner && !documentImageBytes.isCurrent(selection.owner)))) {
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
  const reservation = selection?.owner ? documentImageBytes.reserve(selection.owner) : undefined;
  let prepared: PreparedDocumentImage | undefined;
  try {
    // The captured Resource ID is the authority; the display path never creates it.
    const sourceBytes = selection
      ? await nativeFs.readBytes(selection.expectedGrantId, '', IMAGE_BYTE_LIMIT)
      : undefined;
    assertCurrent(selection);
    if (sourceBytes && sourceBytes.byteLength > IMAGE_BYTE_LIMIT) throw new Error('image_too_large');
    const { stem, ext } = splitFilename(srcPath);
    const finish = (markdownPath: string): ImportedImage => {
      assertCurrent(selection);
      if (reservation && sourceBytes) prepared = reservation.prepare(markdownPath, sourceBytes);
      return { markdownPath, altText: stem, ...(prepared ? { prepared } : {}) };
    };
    const docDir = docPath ? getDirectoryFromFilePath(docPath) : null;
    if (!docDir) return finish(toForwardSlashes(srcPath));
    const targetDir = `${docDir}/${IMAGES_DIR}`;
    await mkdir(targetDir, { recursive: true });
    assertCurrent(selection);
    const finalName = await resolveCollision(targetDir, stem, ext, selection);
    assertCurrent(selection);
    const result = finish(`${IMAGES_DIR}/${finalName}`);
    const targetPath = `${targetDir}/${finalName}`;
    if (sourceBytes) await writeFile(targetPath, sourceBytes);
    else await copyFile(srcPath, targetPath);
    assertCurrent(selection);
    return result;
  } catch (error) {
    prepared?.release();
    throw error;
  } finally {
    if (!prepared) reservation?.release();
  }
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
  context?: ImageImportContext,
): Promise<ImportedImage> {
  assertCurrent(context);
  if (bytes.byteLength > IMAGE_BYTE_LIMIT) throw new Error('image_too_large');
  const reservation = context?.owner ? documentImageBytes.reserve(context.owner, bytes.byteLength) : undefined;
  // Clipboard callers can retain/mutate their input while destination I/O awaits.
  bytes = bytes.slice();
  let prepared: PreparedDocumentImage | undefined;
  const stem = `${stemHint}-${Date.now()}`;
  const finish = (markdownPath: string): ImportedImage => {
    assertCurrent(context);
    if (reservation) prepared = reservation.prepare(markdownPath, bytes);
    return { markdownPath, altText: stem, ...(prepared ? { prepared } : {}) };
  };
  try {
    const docDir = docPath ? getDirectoryFromFilePath(docPath) : null;
    if (!docDir) {
      let targetPath: string;
      try {
        const dir = await getUnsavedImagesDir(context);
        assertCurrent(context);
        const finalName = await resolveCollision(dir, stem, ext, context);
        targetPath = `${dir}/${finalName}`;
        assertCurrent(context);
        await writeFile(targetPath, bytes);
        assertCurrent(context);
      } catch (error) {
        assertCurrent(context);
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        const blob = new Blob([bytes], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` });
        const dataUrl = await blobToDataUrl(blob);
        return finish(dataUrl);
      }
      return finish(targetPath);
    }
    const targetDir = `${docDir}/${IMAGES_DIR}`;
    await mkdir(targetDir, { recursive: true });
    assertCurrent(context);
    const finalName = await resolveCollision(targetDir, stem, ext, context);
    const result = finish(`${IMAGES_DIR}/${finalName}`);
    await writeFile(`${targetDir}/${finalName}`, bytes);
    assertCurrent(context);
    return result;
  } catch (error) {
    prepared?.release();
    throw error;
  } finally {
    if (!prepared) reservation?.release();
  }
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
  selection?: ImageImportContext,
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
