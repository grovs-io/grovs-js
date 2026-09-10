import { beforeEach } from 'vitest';
import { __resetScreenDedup } from '../src/events/custom-events-handler';
import { __resetPatchOwner } from '../src/tracking/auto-screen-tracker';
import { __resetPendingConsentStore } from '../src/core/client';
import { __resetPageAttribution } from '../src/events/events-handler';

// Module-level, so they would otherwise leak between tests. The launch-event
// guard lives there too: a test inheriting it from the previous one would see
// no app_open and pass or fail for the wrong reason.
beforeEach(__resetScreenDedup);
beforeEach(__resetPatchOwner);
beforeEach(__resetPendingConsentStore);
beforeEach(__resetPageAttribution);

/**
 * jsdom implements no canvas backend, so HTMLCanvasElement.getContext throws
 * "Not implemented" and prints a stack for every call. The SDK catches it —
 * that is the same path a privacy-hardened browser takes — but the noise
 * buries real failures.
 *
 * Returning null models jsdom's actual capability rather than suppressing the
 * symptom. Tests that need WebGL values stub getContext themselves.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function getContext(): null {
    return null;
  } as unknown as HTMLCanvasElement['getContext'];
}
