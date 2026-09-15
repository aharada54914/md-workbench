import type { Ref } from 'vue';
import type { CodeEditorHandle } from '../types/code-editor';
import { isImageFile, escapeMarkdownAlt } from '../utils/image-file-utils';
import { importImage, type ImportedImage } from '../services/imageImport';
import type { NativeGrant } from '../services/nativeFs';

export interface InsertableImage {
  path: string;
  alt: string;
}

export interface ImageDropTarget {
  filePath: string | null;
  insertImages: (items: InsertableImage[]) => void;
  isCurrent?: () => boolean;
}

function toInsertable(item: ImportedImage): InsertableImage {
  return { path: item.markdownPath, alt: item.altText };
}

export interface UseImageDropOptions {
  codeView: Ref<boolean>;
  codeEditor: () => CodeEditorHandle | null;
  activeFilePath: () => string | null;
  findVisualTargetAt: (x: number, y: number) => ImageDropTarget | null;
  onImagesImported?: (isCurrent?: () => boolean) => void;
  onError?: (message: string) => void;
}

export interface ImageDropSelection {
  grants: NativeGrant[];
  isCurrent: () => boolean;
}

export interface UseImageDropReturn {
  handleDrop: (
    paths: string[],
    position: { x: number; y: number },
    selection?: ImageDropSelection,
  ) => Promise<void>;
}

export function useImageDrop(options: UseImageDropOptions): UseImageDropReturn {
  const handleDrop: UseImageDropReturn['handleDrop'] = async (paths, position, selection) => {
    if (selection && !selection.isCurrent()) return;
    const imagePaths = paths.filter(isImageFile);
    if (imagePaths.length === 0) return;

    if (options.codeView.value) {
      await insertIntoCodeEditor(imagePaths, options, selection);
    } else {
      await insertIntoVisualPane(imagePaths, position, options, selection);
    }

    if (!selection || selection.isCurrent()) options.onImagesImported?.(selection?.isCurrent);
  };

  return { handleDrop };
}

async function insertIntoVisualPane(
  paths: string[],
  position: { x: number; y: number },
  options: UseImageDropOptions,
  selection?: ImageDropSelection,
): Promise<void> {
  const dpr = window.devicePixelRatio || 1;
  const target = options.findVisualTargetAt(position.x / dpr, position.y / dpr);
  if (!target) return;

  const filePath = target.filePath;
  const isCurrent = () => (!selection || selection.isCurrent())
    && !options.codeView.value
    && (target.isCurrent?.() ?? true)
    && options.findVisualTargetAt(position.x / dpr, position.y / dpr)?.filePath === filePath;
  const items = await importAll(paths, filePath, options.onError, selection, isCurrent);
  if (isCurrent() && items.length > 0) target.insertImages(items.map(toInsertable));
}

async function insertIntoCodeEditor(
  paths: string[],
  options: UseImageDropOptions,
  selection?: ImageDropSelection,
): Promise<void> {
  const editor = options.codeEditor();
  if (!editor) return;

  const filePath = options.activeFilePath();
  const isCurrent = () => (!selection || selection.isCurrent())
    && options.codeView.value
    && options.codeEditor() === editor
    && options.activeFilePath() === filePath;
  const items = await importAll(paths, filePath, options.onError, selection, isCurrent);
  if (!isCurrent() || items.length === 0) return;

  const markdown = buildMarkdownBlock(items);
  insertAtCursor(editor, markdown);
}

async function importAll(
  paths: string[],
  docPath: string | null,
  onError: ((msg: string) => void) | undefined,
  selection: ImageDropSelection | undefined,
  isCurrent: () => boolean,
): Promise<ImportedImage[]> {
  const results: ImportedImage[] = [];
  for (const src of paths) {
    if (!isCurrent()) break;
    try {
      const grant = selection?.grants.find((item) => item.path === src && item.kind === 'resource' && item.read);
      if (selection && !grant) throw new Error('Image source has no matching OS grant');
      const item = selection && grant
        ? await importImage(src, docPath, { expectedGrantId: grant.id, isCurrent })
        : await importImage(src, docPath);
      if (!isCurrent()) break;
      results.push(item);
    } catch (err) {
      if (!isCurrent()) break;
      console.warn('[useImageDrop] Failed to import image:', src, err);
      onError?.(src);
    }
  }
  return results;
}

function buildMarkdownBlock(items: ImportedImage[]): string {
  return items
    .map((item) => `![${escapeMarkdownAlt(item.altText)}](${item.markdownPath})`)
    .join('\n\n');
}

function insertAtCursor(editor: CodeEditorHandle, text: string): void {
  const value = editor.getValue();
  const { start, end } = editor.getSelection();
  const before = value.slice(0, start);
  const after = value.slice(end);

  const needsLeadingNewline = before.length > 0 && !before.endsWith('\n');
  const needsTrailingNewline = after.length > 0 && !after.startsWith('\n');

  const prefix = needsLeadingNewline ? '\n' : '';
  const suffix = needsTrailingNewline ? '\n' : '';
  const payload = `${prefix}${text}${suffix}`;

  editor.replaceSelection(payload);
  editor.focus();
}
