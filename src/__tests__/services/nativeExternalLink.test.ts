import { describe, it, expect, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { openExternal, openExternalWithFeedback } from '../../services/nativeExternalLink';

describe('native external link boundary', () => {
  it('shows the localized failure once without swallowing successful dispatch', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    try {
      invoke.mockResolvedValueOnce(undefined);
      await openExternalWithFeedback('https://example.com/', 'Could not open');
      expect(alert).not.toHaveBeenCalled();
      invoke.mockRejectedValueOnce('open_failed');
      await openExternalWithFeedback('https://example.com/', 'Could not open');
      expect(alert).toHaveBeenCalledExactlyOnceWith('Could not open');
    } finally { alert.mockRestore(); }
  });
  it('passes only the URL to the native caller gate and preserves rejection', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await openExternal('https://example.com/');
    expect(invoke).toHaveBeenLastCalledWith('native_open_external_link', { url: 'https://example.com/' });
    invoke.mockRejectedValueOnce('invalid_url');
    await expect(openExternal('file:///tmp/example')).rejects.toBe('invalid_url');
  });
});
