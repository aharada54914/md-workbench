import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentImageBytes, IMAGE_BYTE_LIMIT } from '../../services/documentImageBytes';
import { createDocumentImageDisplay, type DocumentImageDisplay, type ImageDisplayContext } from '../../services/documentImageDisplay';
import { nativeFs } from '../../services/nativeFs';

vi.mock('../../services/nativeFs', () => ({ nativeFs: {
  resolveDocumentReadGrant: vi.fn(), readDocumentImageBytes: vi.fn(),
} }));
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
let providers: DocumentImageDisplay[];
function setup(beforeRelease?: (url: string) => void | Promise<void>) {
  let context: ImageDisplayContext = { owner: documentImageBytes.createOwner(), path: '/work/note.md', revision: 0 };
  const provider = createDocumentImageDisplay({ getContext: () => context, beforeRelease });
  providers.push(provider);
  return { provider, get context() { return context; }, setContext(value: Partial<ImageDisplayContext>) { context = { ...context, ...value }; provider.refresh(); } };
}
function hold(owner: NonNullable<ImageDisplayContext['owner']>, path: string, bytes = png) {
  documentImageBytes.reserve(owner, bytes.length).prepare(path, bytes).commit();
}
beforeEach(() => {
  providers = []; vi.resetAllMocks();
  vi.mocked(nativeFs.resolveDocumentReadGrant).mockResolvedValue({ grantId: 'current-document' });
  vi.mocked(nativeFs.readDocumentImageBytes).mockResolvedValue(png);
  let id = 0;
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => `blob:owned-${++id}`), revokeObjectURL: vi.fn() }));
});
afterEach(async () => { providers.forEach(provider => provider.dispose()); await flush(); documentImageBytes.disposeAll(); vi.unstubAllGlobals(); });

describe('authorized image display', () => {
  it('uses exact-owner retained snapshots even for absolute paths; only owned blobs enter DOM', async () => {
    const a = setup(); const image = document.createElement('img'); image.src = 'file:///secret'; image.srcset = '/secret 2x';
    hold(a.context.owner!, '/source/original.png');
    a.provider.attach(image, '/source/original.png'); await flush();
    expect(image.getAttribute('src')).toBe('blob:owned-1'); expect(image.hasAttribute('srcset')).toBe(false);
    expect(nativeFs.resolveDocumentReadGrant).not.toHaveBeenCalled();
    const b = setup(); const denied = document.createElement('img'); b.provider.attach(denied, '/source/original.png'); await flush();
    expect(denied.hasAttribute('src')).toBe(false); expect(denied.dataset.imageStatus).toBe('unavailable');
  });
  it('keeps percent names literal and uses the current descriptor; descriptors share only the context', async () => {
    const a = setup();
    a.provider.attach(document.createElement('img'), 'images/%2e%2e/%2f.png');
    a.provider.attach(document.createElement('img'), 'note.assets/a.png'); await flush();
    expect(nativeFs.resolveDocumentReadGrant).toHaveBeenCalledTimes(1);
    expect(nativeFs.readDocumentImageBytes).toHaveBeenCalledWith('/work/note.md', 'current-document', 'images/%2e%2e/%2f.png');
  });
  it.each(['https://example.com/x.png', 'file:///tmp/a.png', 'blob:authored', '/tmp/a.png', '../images/a.png', 'images/../a.png', 'other.assets/a.png', 'images/a.png?x', 'images\\a.png'])('rejects unsupported source %s without a native read', async source => {
    const a = setup(); const image = document.createElement('img'); a.provider.attach(image, source); await flush();
    expect(image.hasAttribute('src')).toBe(false); expect(nativeFs.resolveDocumentReadGrant).not.toHaveBeenCalled();
  });
  it('keeps rejection terminal until an explicit authority revision changes', async () => {
    vi.mocked(nativeFs.readDocumentImageBytes).mockRejectedValue({ code: 'permission_required' });
    const a = setup(); const image = document.createElement('img'); a.provider.attach(image, 'images/a.png'); await flush();
    a.provider.refresh(); await flush(); expect(nativeFs.readDocumentImageBytes).toHaveBeenCalledTimes(1);
    vi.mocked(nativeFs.readDocumentImageBytes).mockResolvedValue(png); a.setContext({ revision: 1 }); await flush();
    expect(nativeFs.readDocumentImageBytes).toHaveBeenCalledTimes(2); expect(image.src).toBe('blob:owned-1');
  });
  it('cannot install an old in-flight read after owner/path/revision changes or close', async () => {
    const read = deferred<Uint8Array>(); vi.mocked(nativeFs.readDocumentImageBytes).mockReturnValue(read.promise);
    const a = setup(); const image = document.createElement('img'); const binding = a.provider.attach(image, 'images/a.png'); await flush();
    binding.dispose(); read.resolve(png); await flush(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    const next = deferred<Uint8Array>(); vi.mocked(nativeFs.readDocumentImageBytes).mockReturnValue(next.promise);
    a.provider.attach(image, 'images/a.png'); await flush(); a.setContext({ owner: documentImageBytes.createOwner(), path: null, revision: 1 });
    next.resolve(png); await flush(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('removes the visible src and closes preview before URL revocation, once', async () => {
    const closed = deferred<void>(); const order: string[] = [];
    const image = document.createElement('img');
    const a = setup(() => { expect(image.hasAttribute('src')).toBe(false); order.push('close'); return closed.promise; });
    a.provider.attach(image, 'images/a.png'); await flush();
    vi.mocked(URL.revokeObjectURL).mockImplementation(() => { order.push('revoke'); });
    a.provider.dispose(); a.provider.dispose(); await flush(); expect(order).toEqual(['close']);
    closed.resolve(); await flush(); expect(order).toEqual(['close', 'revoke']);
  });
  it('bounds parallel native reads and cancels queued references on dispose', async () => {
    const read = deferred<Uint8Array>(); vi.mocked(nativeFs.readDocumentImageBytes).mockReturnValue(read.promise);
    const a = setup(); for (let i = 0; i < 10; i++) a.provider.attach(document.createElement('img'), `images/${i}.png`);
    await flush(); expect(nativeFs.readDocumentImageBytes).toHaveBeenCalledTimes(4);
    a.provider.dispose(); read.resolve(png); await flush(); expect(nativeFs.readDocumentImageBytes).toHaveBeenCalledTimes(4);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('rejects oversized native results and bounds per-owner live blob bytes', async () => {
    const a = setup(); const tooLarge = document.createElement('img');
    vi.mocked(nativeFs.readDocumentImageBytes).mockResolvedValueOnce(new Uint8Array(IMAGE_BYTE_LIMIT + 1));
    a.provider.attach(tooLarge, 'images/huge.png'); await flush(); expect(tooLarge.hasAttribute('src')).toBe(false);
    const bytes = new Uint8Array(IMAGE_BYTE_LIMIT); bytes.set(png);
    vi.mocked(nativeFs.readDocumentImageBytes).mockResolvedValue(bytes);
    for (let i = 0; i < 9; i++) { a.provider.attach(document.createElement('img'), `images/${i}.png`); await flush(); }
    expect(URL.createObjectURL).toHaveBeenCalledTimes(8);
  });
  it('makes browser decode failure terminal and releases its owned URL', async () => {
    const a = setup(); const image = document.createElement('img'); a.provider.attach(image, 'images/a.png'); await flush();
    image.dispatchEvent(new Event('error')); await flush(); a.provider.refresh();
    expect(image.hasAttribute('src')).toBe(false); expect(image.dataset.imageStatus).toBe('unavailable');
    expect(nativeFs.readDocumentImageBytes).toHaveBeenCalledTimes(1); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  it('accepts bounded data bytes through an owned blob, never an authored data URL', async () => {
    const a = setup(); const image = document.createElement('img'); a.provider.attach(image, 'data:image/png;base64,iVBORw0KGgo='); await flush();
    expect(image.src).toBe('blob:owned-1'); expect(nativeFs.resolveDocumentReadGrant).not.toHaveBeenCalled();
  });
  it('holds the encoded-byte reservation until a pending native read settles after disposal', async () => {
    const read = deferred<Uint8Array>(); vi.mocked(nativeFs.readDocumentImageBytes).mockReturnValue(read.promise);
    const a = setup();
    for (let i = 0; i < 4; i++) a.provider.attach(document.createElement('img'), `images/${i}.png`);
    await flush(); a.provider.dispose();
    const b = setup(); b.setContext({ owner: a.context.owner });
    const bytes = new Uint8Array(IMAGE_BYTE_LIMIT); bytes.set(png);
    vi.mocked(nativeFs.readDocumentImageBytes).mockResolvedValue(bytes);
    for (let i = 0; i < 5; i++) b.provider.attach(document.createElement('img'), `images/new${i}.png`);
    // Four old IPC reads still occupy the scheduler, even after provider close.
    await flush(); expect(nativeFs.readDocumentImageBytes).toHaveBeenCalledTimes(4);
    read.resolve(png); await flush(); expect(URL.createObjectURL).toHaveBeenCalledTimes(5);
  });
  it('bounds display bytes across owners and releases the budget only after preview completion', async () => {
    const closed = deferred<void>(); const bytes = new Uint8Array(IMAGE_BYTE_LIMIT); bytes.set(png);
    vi.mocked(nativeFs.readDocumentImageBytes).mockResolvedValue(bytes);
    const a = setup(() => closed.promise); const b = setup(() => closed.promise);
    for (let i = 0; i < 8; i++) {
      a.provider.attach(document.createElement('img'), `images/a${i}.png`); await flush();
      b.provider.attach(document.createElement('img'), `images/b${i}.png`); await flush();
    }
    a.provider.dispose(); b.provider.dispose();
    const c = setup(); const denied = document.createElement('img'); c.provider.attach(denied, 'images/c.png'); await flush();
    expect(denied.dataset.imageStatus).toBe('unavailable'); expect(URL.createObjectURL).toHaveBeenCalledTimes(16);
    closed.resolve(); await flush(); c.setContext({ revision: 1 }); await flush();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(17);
  });
  it('bounds repeated tiny URL leases even when preview cleanup is stalled', async () => {
    const closed = deferred<void>(); const a = setup(() => closed.promise);
    for (let i = 0; i < 128; i++) {
      const binding = a.provider.attach(document.createElement('img'), `images/${i}.png`); await flush(); binding.dispose();
    }
    const image = document.createElement('img'); a.provider.attach(image, 'images/last.png'); await flush();
    expect(image.dataset.imageStatus).toBe('unavailable'); expect(URL.createObjectURL).toHaveBeenCalledTimes(128);
    closed.resolve(); await flush(); a.setContext({ revision: 1 }); await flush(); expect(image.src).toBe('blob:owned-129');
  });
  it('handles owner disposal and subscription teardown without reviving that owner', async () => {
    const owner = documentImageBytes.createOwner(); let refresh!: () => void; const unsubscribe = vi.fn();
    const provider = createDocumentImageDisplay({ getContext: () => ({ owner, path: '/work/note.md', revision: 0 }),
      subscribeContext(listener) { refresh = listener; return unsubscribe; }, beforeRelease() { throw new Error('UI failure'); },
    }); providers.push(provider);
    const image = document.createElement('img'); provider.attach(image, 'images/a.png'); await flush();
    documentImageBytes.dispose(owner); refresh(); await flush();
    expect(image.hasAttribute('src')).toBe(false); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    provider.dispose(); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
