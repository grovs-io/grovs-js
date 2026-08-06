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
