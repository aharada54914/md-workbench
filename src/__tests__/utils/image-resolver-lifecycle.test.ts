import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorImageResolver, inlineMarkdownImages } from '../../utils/image-resolver';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
const create = vi.fn(() => `blob:owned-${Math.random()}`);
const revoke = vi.fn();
const owners: ReturnType<typeof createEditorImageResolver>[] = [];
function owner() { const result = createEditorImageResolver(); owners.push(result); return result; }
function container(src = '/one.png') {
  const root = document.createElement('div');
  const img = document.createElement('img');
  img.className = 'editor-image'; img.setAttribute('src', src);
  root.append(img); document.body.append(root);
  return { root, img };
}
beforeEach(() => {
  readFile.mockReset(); readFile.mockResolvedValue(new Uint8Array([1]));
  create.mockClear(); revoke.mockClear();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
});
afterEach(() => { for (const instance of owners.splice(0)) instance.dispose(); document.body.replaceChildren(); });

describe('image result ownership regressions', () => {
  it('does not replace a reused image node after its source changes during read', async () => {
    const read = deferred<Uint8Array>(); readFile.mockReturnValueOnce(read.promise);
    const { root, img } = container('/pending.png');
    const work = owner().resolve(root);
    img.setAttribute('src', '/new.png');
    read.resolve(new Uint8Array([1])); await work;
    expect(img.getAttribute('src')).toBe('/new.png');
    expect(create).not.toHaveBeenCalled();
  });

  it('does not create a URL for a node removed during read', async () => {
    const read = deferred<Uint8Array>(); readFile.mockReturnValueOnce(read.promise);
    const { root, img } = container('/removed.png');
    const work = owner().resolve(root); img.remove();
    read.resolve(new Uint8Array([1])); await work;
    expect(create).not.toHaveBeenCalled();
  });

  it('does not reuse a previous document data URI for the same path', async () => {
    readFile.mockResolvedValueOnce(new Uint8Array([1])).mockResolvedValueOnce(new Uint8Array([2]));
    const first = await inlineMarkdownImages('![a](/shared.png)');
    const second = await inlineMarkdownImages('![a](/shared.png)');
    expect(second).not.toBe(first);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('shares a pending read across repeated updates for the same live image', async () => {
    const read = deferred<Uint8Array>();
    readFile.mockReturnValue(read.promise);
    const resolver = owner(); const { root, img } = container();
    const updates = Array.from({ length: 100 }, () => resolver.resolve(root));
    expect(readFile).toHaveBeenCalledTimes(1);
    read.resolve(new Uint8Array([1])); await Promise.all(updates);
    expect(img.src).toMatch(/^blob:/); expect(create).toHaveBeenCalledTimes(1);
  });

  it('starts a new read when the pending request belongs to an invalidated context', async () => {
    const first = deferred<Uint8Array>(); const second = deferred<Uint8Array>();
    readFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const resolver = owner(); const { root, img } = container();
    let current = true;
    const old = resolver.resolve(root, undefined, () => current); current = false;
    const latest = resolver.resolve(root);
    expect(readFile).toHaveBeenCalledTimes(2);
    second.resolve(new Uint8Array([2])); await latest;
    const url = img.src;
    first.resolve(new Uint8Array([1])); await old;
    expect(img.src).toBe(url); expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects a source leave/return before the observer callback', async () => {
    const read = deferred<Uint8Array>(); readFile.mockReturnValueOnce(read.promise);
    const { root, img } = container(); const work = owner().resolve(root);
    img.setAttribute('src', '/two.png'); img.setAttribute('src', '/one.png');
    read.resolve(new Uint8Array([1])); await work;
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['reset', 'dispose'] as const)('%s cancels reads without creating URLs', async action => {
    const read = deferred<Uint8Array>(); readFile.mockReturnValueOnce(read.promise);
    const resolver = owner(); const { root } = container();
    const work = resolver.resolve(root); resolver[action]();
    read.resolve(new Uint8Array([1])); await work;
    expect(create).not.toHaveBeenCalled();
  });

  it('caller context invalidation cancels a still-connected image read', async () => {
    const read = deferred<Uint8Array>(); readFile.mockReturnValueOnce(read.promise);
    const { root } = container(); let current = true;
    const work = owner().resolve(root, undefined, () => current); current = false;
    read.resolve(new Uint8Array([1])); await work;
    expect(create).not.toHaveBeenCalled();
  });

  it('releases removed and replaced URLs while retaining only live display nodes', async () => {
    const resolver = owner(); const { root, img } = container();
    await resolver.resolve(root); const firstUrl = img.src;
    await resolver.resolve(root); expect(readFile).toHaveBeenCalledTimes(1);
    img.setAttribute('src', '/second.png'); await resolver.resolve(root);
    expect(revoke).toHaveBeenCalledWith(firstUrl);
    const secondUrl = img.src; img.remove(); await Promise.resolve();
    expect(revoke).toHaveBeenCalledWith(secondUrl);
    resolver.dispose(); expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('reset restores source for a reused node, then reads again in the new document', async () => {
    const resolver = owner(); const { root, img } = container();
    await resolver.resolve(root); const oldUrl = img.src; resolver.reset();
    expect(img.getAttribute('src')).toBe('/one.png');
    expect(img.getAttribute('data-original-src')).toBe('/one.png');
    expect(revoke).toHaveBeenCalledWith(oldUrl);
    await resolver.resolve(root); expect(img.src).not.toBe(oldUrl);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('a removed and reinserted node is not left displaying a revoked URL', async () => {
    const resolver = owner(); const { root, img } = container();
    await resolver.resolve(root); const oldUrl = img.src;
    img.remove(); root.append(img); await Promise.resolve();
    expect(revoke).toHaveBeenCalledWith(oldUrl);
    expect(img.getAttribute('src')).toBe('/one.png');
    await resolver.resolve(root);
    expect(img.src).toMatch(/^blob:/); expect(img.src).not.toBe(oldUrl);
  });

  it('keeps separate document owners and legacy unsaved absolute sources', async () => {
    const first = container('/app-private/import.png'); const second = container('/app-private/import.png');
    await owner().resolve(first.root); await owner().resolve(second.root);
    expect(first.img.src).not.toBe(second.img.src);
    expect(first.img.getAttribute('data-original-src')).toBe('/app-private/import.png');
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('performs display mutation synchronously after the file read and releases its preview', async () => {
    const read = deferred<Uint8Array>(); readFile.mockReturnValueOnce(read.promise);
    const mutate = vi.fn((apply: () => void) => apply()); const released = vi.fn();
    const resolver = createEditorImageResolver(mutate, released); owners.push(resolver);
    const { root, img } = container(); const work = resolver.resolve(root);
    expect(mutate).not.toHaveBeenCalled(); read.resolve(new Uint8Array([1])); await work;
    expect(mutate).toHaveBeenCalledOnce(); const url = img.src;
    resolver.dispose(); expect(released).toHaveBeenCalledWith(url);
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it('shares duplicate inline reads only within one request and leaves external URLs alone', async () => {
    const markdown = '![a](/same.png) ![b](/same.png) ![c](https://example.com/a.png) ![d](data:image/png;base64,AQ==)';
    const rendered = await inlineMarkdownImages(markdown);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(rendered.match(/data:image\/png;base64,AQ==/g)).toHaveLength(3);
    expect(rendered).toContain('https://example.com/a.png');
  });
});
