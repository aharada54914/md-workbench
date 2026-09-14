import { describe, expect, it, vi } from 'vitest';
import { decodeDocumentUtf8, readTextFile } from '../../services/documentText';
import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('authoritative document UTF-8 decoding', () => {
  it.each(['', '\uFEFF日本語\r\n  \t', 'mixed\r\nnewlines\n\r', '😀'])('preserves %j byte-for-byte', source => {
    const bytes = new TextEncoder().encode(source);
    const decoded = decodeDocumentUtf8(bytes);
    expect(decoded).toBe(source);
    expect(new TextEncoder().encode(decoded)).toEqual(bytes);
  });
  it.each([[0xff], [0xc0, 0xaf], [0xe3, 0x81], [0xed, 0xa0, 0x80]])('rejects malformed bytes %j', (...bytes) => {
    expect(() => decodeDocumentUtf8(Uint8Array.from(bytes))).toThrow();
  });
  it('uses the existing authorized read command and preserves its BOM bytes', async () => {
    const bytes = new TextEncoder().encode('\uFEFF日本語');
    vi.mocked(invoke).mockResolvedValueOnce(Array.from(bytes)).mockResolvedValueOnce(bytes.buffer);
    expect(await readTextFile('C:/test.md')).toBe('\uFEFF日本語');
    expect(await readTextFile('C:/test.md')).toBe('\uFEFF日本語');
    expect(invoke).toHaveBeenCalledWith('plugin:fs|read_text_file', { path: 'C:/test.md' });
  });
});
