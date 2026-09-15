import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { nativeFs, type NativeGrant } from '../../services/nativeFs';
import { MAX_IMAGE_BYTES } from '../../composables/useAiPendingImages';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const call = vi.mocked(invoke);
beforeEach(() => { call.mockReset(); });

it('selects images without renderer-supplied paths or filters and retains each native identity', async () => {
  const selected: NativeGrant[] = [
    { id: 'native-a', path: '/a.png', kind: 'resource', read: true, write: false },
    { id: 'native-b', path: '/b.jpg', kind: 'resource', read: true, write: false },
  ];
  call.mockResolvedValueOnce(selected).mockResolvedValueOnce([0, 128, 255]);
  expect(await nativeFs.pickImages()).toBe(selected);
  expect(Array.from(await nativeFs.readPathBytes(selected[0].path, MAX_IMAGE_BYTES, selected[0].id)))
    .toEqual([0, 128, 255]);
  expect(call.mock.calls).toEqual([
    ['native_pick_images'],
    ['native_read_path', { path: '/a.png', limit: MAX_IMAGE_BYTES, expectedGrantId: 'native-a' }],
  ]);
});

it('preserves cancellation without creating any follow-up authority', async () => {
  call.mockResolvedValue([]);
  expect(await nativeFs.pickImages()).toEqual([]);
  expect(call.mock.calls).toEqual([['native_pick_images']]);
});

it.each(['permission_required', 'selection_limit_exceeded', 'dialog_unavailable'])(
  'preserves the host %s rejection with no legacy fallback', async code => {
    const error = { code, message: 'selection rejected' };
    call.mockRejectedValue(error);
    await expect(nativeFs.pickImages()).rejects.toBe(error);
    expect(call.mock.calls).toEqual([['native_pick_images']]);
  },
);

it('rejects a stale selection identity without looking up or retrying the newer grant', async () => {
  const error = { code: 'permission_required', message: 'selection changed' };
  call.mockRejectedValue(error);
  await expect(nativeFs.readPathBytes('/a.png', MAX_IMAGE_BYTES, 'old-id')).rejects.toBe(error);
  expect(call.mock.calls).toEqual([
    ['native_read_path', { path: '/a.png', limit: MAX_IMAGE_BYTES, expectedGrantId: 'old-id' }],
  ]);
});
