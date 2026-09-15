import { documentImageBytes, IMAGE_BYTE_LIMIT, type ImageDocumentOwner } from '../services/documentImageBytes';
import { importImageBytes } from '../services/imageImport';

interface PasteTarget {
  owner: ImageDocumentOwner;
  path: string | null;
  isCurrent(): boolean;
  /** Model insertion must complete synchronously after the snapshot commit. */
  insert(image: { path: string; alt: string }): void;
}

const mimeToExtension = (mime: string): string => {
  const type = mime.toLowerCase();
  if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg';
  if (type === 'image/svg+xml') return 'svg';
  return type.includes('/') ? type.slice(type.indexOf('/') + 1) : 'png';
};

/** The caller captures editor/document identity before starting this operation. */
export async function importPastedEditorImage(file: File, target: PasteTarget): Promise<void> {
  const isCurrent = () => target.isCurrent() && documentImageBytes.isCurrent(target.owner);
  const check = () => { if (!isCurrent()) throw new DOMException('Image paste is no longer current', 'AbortError'); };
  check();
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > IMAGE_BYTE_LIMIT) throw new Error('image_too_large');
  const allocation = documentImageBytes.reserve(target.owner, file.size);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    check();
    if (bytes.byteLength > file.size || bytes.byteLength > IMAGE_BYTE_LIMIT) throw new Error('image_too_large');
    // Handoff is synchronous: importImageBytes reserves before its first await.
    // This avoids double-counting the same image while retaining preallocation bounds.
    allocation.release();
    const image = await importImageBytes(bytes, mimeToExtension(file.type), target.path,
      file.name ? file.name.replace(/\.[^.]+$/, '') : 'pasted-image', { owner: target.owner, isCurrent });
    try {
      check();
      image.prepared?.commit();
      target.insert({ path: image.markdownPath, alt: image.altText });
    } finally { image.prepared?.release(); }
  } finally { allocation.release(); }
}
