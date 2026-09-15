import { t } from '../i18n';

/** Keep host details out of the alert and explain how to restore authority. */
export function describeRevealError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'permission_required') return t.value.revealPermissionRequired;
  if (code === 'unsupported_platform' || code === 'unsupported_operation') {
    return t.value.workspaceMutationUnsupported;
  }
  return t.value.revealFailed;
}
