import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { nativeFs, type NativeDrop } from '../services/nativeFs';

/** Serialize completed native selections. Renderer drag events cannot supply paths. */
export function useNativeDrops(options: {
  handleDrop: (drop: NativeDrop, isCurrent: () => boolean) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  type Session = { draining: boolean; dirty: boolean; unlisten?: UnlistenFn };
  let session: Session | undefined;

  const drain = async (current: Session): Promise<void> => {
    current.dirty = true;
    if (current.draining || session !== current) return;
    current.draining = true;
    try {
      while (session === current && current.dirty) {
        current.dirty = false;
        const drops = await nativeFs.takeDrops();
        if (session !== current) return;
        for (const drop of drops) {
          if (session !== current) return;
          try {
            await options.handleDrop(drop, () => session === current);
          } catch (error) {
            if (session === current) options.onError(error);
          }
        }
      }
    } catch (error) {
      if (session === current) options.onError(error);
    } finally {
      current.draining = false;
    }
  };

  const start = async (): Promise<void> => {
    if (session) return;
    const current: Session = { draining: false, dirty: false };
    session = current;
    try {
      const unlisten = await listen('native-drops-pending', () => { void drain(current); });
      if (session !== current) {
        unlisten();
        return;
      }
      current.unlisten = unlisten;
      // Drops can arrive before the frontend listener has been registered.
      await drain(current);
    } catch (error) {
      if (session === current) {
        session = undefined;
        options.onError(error);
      }
    }
  };

  const stop = (): void => {
    const previous = session;
    session = undefined;
    previous?.unlisten?.();
  };

  return { start, stop };
}
