import { describe, expect, it } from 'vitest';
import { createDocumentImageBytes, IMAGE_BYTE_LIMIT, DOCUMENT_IMAGE_ENTRY_LIMIT } from '../../services/documentImageBytes';

describe('document image snapshots', () => {
  it('copies imported bytes and isolates owners with the same literal path', () => {
    const store = createDocumentImageBytes();
    const a = store.createOwner(), b = store.createOwner();
    const input = new Uint8Array([1, 2]);
    const prepared = store.reserve(a, 2).prepare('/same.png', input);
    input[0] = 9;
    expect(store.read(a, '/same.png')).toBeUndefined();
    prepared.commit();
    prepared.release();
    const result = store.read(a, '/same.png')!;
    result[0] = 8;
    expect(store.read(a, '/same.png')).toEqual(new Uint8Array([1, 2]));
    expect(store.read(b, '/same.png')).toBeUndefined();
  });

  it('reuses identical snapshots but rejects pending and committed conflicting bytes', () => {
    const store = createDocumentImageBytes(), owner = store.createOwner();
    const a = store.reserve(owner, 1).prepare('x', new Uint8Array([1]));
    expect(() => store.reserve(owner, 1).prepare('x', new Uint8Array([2]))).toThrow('image_path_conflict');
    a.commit();
    store.reserve(owner, 1).prepare('x', new Uint8Array([1])).commit();
    expect(() => store.reserve(owner, 1).prepare('x', new Uint8Array([2]))).toThrow('image_path_conflict');
    expect(store.read(owner, 'x')).toEqual(new Uint8Array([1]));
  });

  it('releases failed, cancelled and disposed reservations exactly once', () => {
    const store = createDocumentImageBytes(), owner = store.createOwner();
    const reservations = Array.from({ length: 8 }, () => store.reserve(owner));
    expect(() => store.reserve(owner, 1)).toThrow('image_budget_exceeded');
    reservations[0]!.release(); reservations[0]!.release();
    const late = store.reserve(owner).prepare('late', new Uint8Array([1]));
    store.dispose(owner); store.dispose(owner);
    for (const reservation of reservations) reservation.release();
    expect(() => late.commit()).toThrow('Image document is closed');
    expect(() => store.read(owner, 'late')).toThrow('Image document is closed');
    expect(store.isCurrent(owner)).toBe(false);
    const replacement = store.createOwner();
    expect(store.read(replacement, 'late')).toBeUndefined();
    for (let i = 0; i < 8; i++) store.reserve(replacement);
  });

  it('counts window reservations across owners and restores capacity on disposal', () => {
    const store = createDocumentImageBytes();
    const a = store.createOwner(), b = store.createOwner(), c = store.createOwner();
    for (const owner of [a, b]) for (let i = 0; i < 8; i++) store.reserve(owner);
    expect(() => store.reserve(c, 1)).toThrow('image_budget_exceeded');
    store.dispose(a);
    for (let i = 0; i < 8; i++) store.reserve(c);
    store.disposeAll();
    expect(store.isCurrent(b)).toBe(false);
  });

  it('counts pending and zero-byte committed entries, including the exact 128 boundary', () => {
    const store = createDocumentImageBytes(), owner = store.createOwner();
    for (let i = 0; i < DOCUMENT_IMAGE_ENTRY_LIMIT - 1; i++) store.reserve(owner, 0).prepare(`${i}`, new Uint8Array()).commit();
    const last = store.reserve(owner, 0);
    expect(() => store.reserve(owner, 0)).toThrow('image_budget_exceeded');
    last.release();
    store.reserve(owner, 0).prepare('last', new Uint8Array()).commit();
    expect(() => store.reserve(owner, 0)).toThrow('image_budget_exceeded');
  });

  it.each([-1, 0.5, NaN, Infinity, IMAGE_BYTE_LIMIT + 1])('rejects invalid reservation %s before allocation', (size) => {
    const store = createDocumentImageBytes(), owner = store.createOwner();
    expect(() => store.reserve(owner, size)).toThrow('image_too_large');
    expect(() => store.reserve(owner)).not.toThrow();
  });

  it('reduces max read reservations to actual bytes and releases oversize preparation', () => {
    const store = createDocumentImageBytes(), owner = store.createOwner();
    expect(() => store.reserve(owner, 1).prepare('x', new Uint8Array([1, 2]))).toThrow('image_too_large');
    for (let i = 0; i < 20; i++) store.reserve(owner).prepare(`${i}`, new Uint8Array([i])).commit();
    expect(store.read(owner, '19')).toEqual(new Uint8Array([19]));
  });

  it('cannot prepare or commit after release, or reuse a token', () => {
    const store = createDocumentImageBytes(), owner = store.createOwner();
    const reservation = store.reserve(owner, 1);
    reservation.release();
    expect(() => reservation.prepare('x', new Uint8Array([1]))).toThrow('expired');
    const pending = store.reserve(owner, 1).prepare('x', new Uint8Array([1]));
    pending.release();
    expect(() => pending.commit()).toThrow('expired');
    expect(store.read(owner, 'x')).toBeUndefined();
  });
  it('reports pending and committed local images without exposing bytes', () => {
    const store = createDocumentImageBytes(), owner = store.createOwner();
    expect(store.hasLocalImages(owner)).toBe(false);
    const reservation = store.reserve(owner, 0);
    expect(store.hasLocalImages(owner)).toBe(true);
    reservation.release();
    expect(store.hasLocalImages(owner)).toBe(false);
    store.reserve(owner, 0).prepare('x', new Uint8Array()).commit();
    expect(store.hasLocalImages(owner)).toBe(true);
    store.dispose(owner);
    expect(store.hasLocalImages(owner)).toBe(false);
  });

});
