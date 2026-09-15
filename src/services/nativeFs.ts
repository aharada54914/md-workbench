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

export interface NativeFsError {
  code:
    | 'permission_required'
    | 'invalid_path'
    | 'invalid_grant_kind'
    | 'unsupported_platform'
    | 'file_too_large'
    | 'native_state_unavailable'
    | 'dialog_unavailable'
    | 'filesystem_error';
  message: string;
}

export const MAX_NATIVE_READ_BYTES = 64 * 1024 * 1024;

/** Native grants are scoped to the invoking editor window. Never fall back to
 * plugin-fs when authority is missing or revoked. Callers handle typed rejects. */
export const nativeFs = {
  getGrant: (path: string) => invoke<NativeGrant | null>('native_get_grant', { path }),
  pickDocuments: () => invoke<NativeGrant[]>('native_pick_documents'),
  pickSaveDestination: () => invoke<NativeGrant | null>('native_pick_save_destination'),
  pickWorkspace: () => invoke<NativeGrant | null>('native_pick_workspace'),
  pickResource: () => invoke<NativeGrant | null>('native_pick_resource'),

  async readBytes(id: string, relative = '', limit = MAX_NATIVE_READ_BYTES): Promise<Uint8Array> {
    const bytes = await invoke<number[]>('native_read_grant', { id, relative, limit });
    return Uint8Array.from(bytes);
  },

  async readText(id: string, relative = '', limit = MAX_NATIVE_READ_BYTES): Promise<string> {
    return decodeDocumentUtf8(await nativeFs.readBytes(id, relative, limit));
  },
};
