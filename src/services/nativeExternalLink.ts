import { invoke } from '@tauri-apps/api/core';

/** Native validation and the live editor caller gate precede OS dispatch. */
export function openExternal(url: string): Promise<void> {
  return invoke<void>('native_open_external_link', { url });
}

/** Settings links have no dialog owner to report native dispatch failures. */
export async function openExternalWithFeedback(url: string, failureMessage: string): Promise<void> {
  try { await openExternal(url); }
  catch { window.alert(failureMessage); }
}
