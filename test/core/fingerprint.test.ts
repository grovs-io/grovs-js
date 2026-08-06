import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFingerprintCache,
  getCrypto,
  getFingerprint,
} from '../../src/core/environment';
import { randomUUID } from '../../src/core/uuid';

describe('getFingerprint', () => {
  beforeEach(() => __resetFingerprintCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetFingerprintCache();
  });

  it('reports screen dimensions', () => {
    const fingerprint = getFingerprint();
    expect(typeof fingerprint.screen_width).toBe('number');
    expect(typeof fingerprint.screen_height).toBe('number');
  });

  it('reports an IANA timezone', () => {
    expect(getFingerprint().timezone).toMatch(/^[A-Za-z]+\/[A-Za-z_+\-/]+$|^UTC$/);
  });

  it('reports the navigator language', () => {
    expect(getFingerprint().language).toBe(navigator.language);
  });

  // A privacy-hardened browser refuses WebGL entirely. Degrading the match is
  // correct; failing the request is not.
  it('omits WebGL fields when no context is available', () => {
    const fingerprint = getFingerprint();
    expect(fingerprint.webgl_vendor).toBeUndefined();
    expect(fingerprint.webgl_renderer).toBeUndefined();
  });

  it('reads unmasked WebGL strings when the extension is available', () => {
    const gl = {
      getExtension: (name: string) =>
        name === 'WEBGL_debug_renderer_info'
          ? { UNMASKED_VENDOR_WEBGL: 1, UNMASKED_RENDERER_WEBGL: 2 }
          : { loseContext: () => undefined },
      getParameter: (param: number) => (param === 1 ? 'Acme Inc.' : 'Acme GPU 9000'),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      gl as unknown as RenderingContext,
    );

    const fingerprint = getFingerprint();
    expect(fingerprint.webgl_vendor).toBe('Acme Inc.');
    expect(fingerprint.webgl_renderer).toBe('Acme GPU 9000');
  });

  // Creating a canvas and a GL context is the most expensive thing the SDK
  // does at startup, so it must happen at most once.
  it('reads WebGL only once per page', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    getFingerprint();
    getFingerprint();
    getFingerprint();

    // One read is two calls — 'webgl' falling through to 'experimental-webgl'.
    // Uncached, three getFingerprint() calls would be six.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('survives a getContext that throws', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => getFingerprint()).not.toThrow();
    expect(getFingerprint().webgl_vendor).toBeUndefined();
  });

  it('returns an empty fingerprint outside a browser', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('document', undefined);
    const fingerprint = getFingerprint();
    expect(fingerprint.screen_width).toBeUndefined();
    expect(fingerprint.language).toBeUndefined();
  });
});

describe('randomUUID', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('produces a v4 UUID', () => {
    expect(randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('produces distinct values', () => {
    const ids = new Set(Array.from({ length: 500 }, () => randomUUID()));
    expect(ids.size).toBe(500);
  });

  // crypto.randomUUID is unavailable on http:// origins, so the fallback is a
  // real code path, not a theoretical one. event_id is deduped on, so it must
  // not collide there either.
  it('falls back to getRandomValues when randomUUID is absent', () => {
    const real = getCrypto();
    vi.stubGlobal('crypto', {
      getRandomValues: real?.getRandomValues.bind(real),
    });

    const ids = new Set(Array.from({ length: 500 }, () => randomUUID()));
    expect(ids.size).toBe(500);
    expect([...ids][0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('falls back to Math.random with no crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
