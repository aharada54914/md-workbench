import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAutoUpdate } from '../../composables/useAutoUpdate';

const spies = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: spies.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: spies.relaunch }));

describe('unconfigured fork distribution', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('never checks, fetches, installs, or relaunches, including direct manual calls', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    localStorage.setItem('updatesEnabled', 'true');
    const api = useAutoUpdate();
    await api.checkForUpdates();
    await api.checkForUpdatesManual();
    // A stale candidate must not turn the disabled distribution into an installer.
    api.updateInfo.value = { version: '99.0.0', notes: 'stale' };
    await api.downloadAndInstallUpdate();
    expect(api.updatesEnabled).toBe(false);
    expect(spies.check).not.toHaveBeenCalled();
    expect(spies.relaunch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(api.isCheckingForUpdates.value).toBe(false);
    expect(api.isUpdating.value).toBe(false);
    expect(api.noUpdateFound.value).toBe(false);
    api.updateInfo.value = null;
    localStorage.clear();
  });
});
