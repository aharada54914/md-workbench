import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Packer } from 'docx';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import * as serializer from '../../utils/documentSerializer';
import { useDocxExport } from '../../composables/useDocxExport';

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(save).mockReset();
  vi.mocked(writeFile).mockReset();
  document.body.innerHTML = '<div class="ProseMirror"><p>Original document</p></div>';
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('DOCX export content ownership', () => {
  it('exports the initiating document snapshot even if its editor DOM changes during the save dialog', async () => {
    const choice = deferred<string | null>();
    vi.mocked(save).mockReturnValue(choice.promise);
    const serialize = vi.spyOn(serializer, 'serializeEditorContent');
    const bytes = new Uint8Array([1, 2, 3]);
    vi.spyOn(Packer, 'toBlob').mockResolvedValue({ arrayBuffer: async () => bytes.buffer } as Blob);
    const work = useDocxExport().exportDocx();
    document.querySelector('.ProseMirror')!.innerHTML = '<p>Another document after switching tabs</p>';
    choice.resolve('/selected/original.docx');
    await work;
    expect(serialize).toHaveBeenCalledOnce();
    expect(serialize.mock.results[0].value).toContain('Original document');
    expect(serialize.mock.results[0].value).not.toContain('Another document');
    expect(writeFile).toHaveBeenCalledExactlyOnceWith('/selected/original.docx', bytes);
  });

  it('does not pack or write when the dialog is cancelled', async () => {
    vi.mocked(save).mockResolvedValue(null);
    const pack = vi.spyOn(Packer, 'toBlob');
    await useDocxExport().exportDocx();
    expect(pack).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('does not open the dialog without an editor', async () => {
    document.body.innerHTML = '';
    await useDocxExport().exportDocx();
    expect(save).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('propagates packing failure without writing a partial export', async () => {
    vi.mocked(save).mockResolvedValue('/selected/export.docx');
    const error = new Error('packing failed');
    vi.spyOn(Packer, 'toBlob').mockRejectedValue(error);
    await expect(useDocxExport().exportDocx()).rejects.toBe(error);
    expect(writeFile).not.toHaveBeenCalled();
  });
});


it('converts the captured DOCX HTML without the browsing-capable HTML parser', async () => {
  vi.mocked(save).mockResolvedValue('/selected/export.docx');
  vi.spyOn(serializer, 'serializeEditorContent').mockReturnValue('<h1>日本語</h1><img src="https://example.invalid/authored.png"><p>Exact text</p>');
  const parse = vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(() => {
    throw new Error('Browsing-capable HTML parser must not run');
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const pack = vi.spyOn(Packer, 'toBlob').mockResolvedValue({ arrayBuffer: async () => bytes.buffer } as Blob);
  await useDocxExport().exportDocx();
  expect(parse).not.toHaveBeenCalled();
  expect(pack).toHaveBeenCalledOnce();
  expect(writeFile).toHaveBeenCalledExactlyOnceWith('/selected/export.docx', bytes);
});
