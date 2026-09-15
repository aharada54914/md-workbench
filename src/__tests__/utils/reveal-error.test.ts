import { describe, expect, it } from 'vitest';
import { describeRevealError } from '../../utils/reveal-error';
import { t } from '../../i18n';

describe('file manager errors', () => {
  it('explains how to restore file or folder access', () => {
    expect(describeRevealError({ code: 'permission_required', message: 'secret' }))
      .toBe(t.value.revealPermissionRequired);
  });
  it.each(['unsupported_platform', 'unsupported_operation'])('explains %s', code => {
    expect(describeRevealError({ code })).toBe(t.value.workspaceMutationUnsupported);
  });
  it.each([null, 'secret host details', { code: 'filesystem_error', message: 'secret' }])(
    'shows a readable fallback without host details', error => {
      expect(describeRevealError(error)).toBe(t.value.revealFailed);
    },
  );
});
