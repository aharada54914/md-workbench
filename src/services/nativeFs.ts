import { invoke } from '@tauri-apps/api/core';
import { decodeDocumentUtf8 } from './documentText';

/** Describes authority already issued by the host; paths never grant access. */
export interface NativeGrant {
  id: string;
  path: string;
  kind: 'document' | 'workspace' | 'resource' | 'export';
  read: boolean;
  write: boolean;
}

/** A completed host OS drop. Event payloads only wake the queue reader. */
export interface NativeDrop {
  id: string;
  grants: NativeGrant[];
  errors: { path: string; error: string }[];
  position: { x: number; y: number };
}

export interface NativeFsError {
  code:
    | 'permission_required'
    | 'invalid_path'
    | 'invalid_grant_kind'
    | 'unsupported_platform'
    | 'file_too_large'
    | 'file_not_found'
    | 'native_state_unavailable'
    | 'dialog_unavailable'
    | 'filesystem_error';
  message: string;
}

export const MAX_NATIVE_READ_BYTES = 64 * 1024 * 1024;
export const MAX_NATIVE_DIRECTORY_ENTRIES = 10_000;

export interface NativeDirectoryListing {
  entries: { name: string; isDirectory: boolean }[];
  omitted: number;
}

/** Current document/workspace READ identity, checked against a regular document. */
export interface NativeImageDocument {
  grantId: string;
}

/** Native grants are scoped to the invoking editor window. Never fall back to
 * plugin-fs when authority is missing or revoked. Callers handle typed rejects. */
export const nativeFs = {
  revealPath: (path: string, expectedGrantId?: string) =>
    invoke<void>('reveal_in_os', {
      path, ...(expectedGrantId === undefined ? {} : { expectedGrantId }),
    }),
  takeDrops: () => invoke<NativeDrop[]>('native_take_drops'),
  getGrant: (path: string) => invoke<NativeGrant | null>('native_get_grant', { path }),
  pickDocuments: () => invoke<NativeGrant[]>('native_pick_documents'),
  pickSaveDestination: () => invoke<NativeGrant | null>('native_pick_save_destination'),
  pickWorkspace: () => invoke<NativeGrant | null>('native_pick_workspace'),
  pickResource: () => invoke<NativeGrant | null>('native_pick_resource'),

  listDirectory: (path: string, limit = MAX_NATIVE_DIRECTORY_ENTRIES) =>
    invoke<NativeDirectoryListing>('native_list_directory', { path, limit }),

  resolveImageDocument: (documentPath: string) =>
    invoke<NativeImageDocument>('native_resolve_image_document', { documentPath }),

  /** Literal filesystem-relative path, not a URL: no percent or image decoding.
   * The host enforces current authority and the fixed 8 MiB limit. Bytes returned
   * here are not validated image content or a guarantee of safe display. */
  async readDocumentImageBytes(
    documentPath: string,
    expectedDocumentGrantId: string,
    relativePath: string,
  ): Promise<Uint8Array> {
    const bytes = await invoke<number[]>('native_read_document_image', {
      documentPath, expectedDocumentGrantId, relativePath,
    });
    return Uint8Array.from(bytes);
  },

  // The host resolves only grants already owned by this caller. This lookup
  // cannot authorize recent/session paths or create access from a path string.
  async readPathBytes(path: string, limit = MAX_NATIVE_READ_BYTES, expectedGrantId?: string): Promise<Uint8Array> {
    const bytes = await invoke<number[]>('native_read_path', {
      path, limit, ...(expectedGrantId === undefined ? {} : { expectedGrantId }),
    });
    return Uint8Array.from(bytes);
  },

  async readPathText(path: string, limit = MAX_NATIVE_READ_BYTES, expectedGrantId?: string): Promise<string> {
    return decodeDocumentUtf8(await nativeFs.readPathBytes(path, limit, expectedGrantId));
  },

  async readBytes(id: string, relative = '', limit = MAX_NATIVE_READ_BYTES): Promise<Uint8Array> {
    const bytes = await invoke<number[]>('native_read_grant', { id, relative, limit });
    return Uint8Array.from(bytes);
  },

  async readText(id: string, relative = '', limit = MAX_NATIVE_READ_BYTES): Promise<string> {
    return decodeDocumentUtf8(await nativeFs.readBytes(id, relative, limit));
  },
};
