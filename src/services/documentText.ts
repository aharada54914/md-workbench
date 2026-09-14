import { invoke } from '@tauri-apps/api/core';

/** UTF-8 only: retain BOM and reject malformed bytes instead of saving U+FFFD. */
export function decodeDocumentUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Same fs permission/command as plugin-fs readTextFile, different decoding
 * contract. The plugin's default TextDecoder silently consumes a UTF-8 BOM. */
export async function readTextFile(path: string): Promise<string> {
  const raw = await invoke<ArrayBuffer | number[]>('plugin:fs|read_text_file', { path });
  return decodeDocumentUtf8(Array.isArray(raw) ? Uint8Array.from(raw) : new Uint8Array(raw));
}
