/**
 * The only module permitted to reference browser globals.
 *
 * Spec A1: nothing here runs at import time. Every function reads the global
 * when called, so importing this module during a Next.js server render is
 * inert. The eslint no-restricted-globals rule enforces the boundary for the
 * rest of src/.
 */

const PROBE_KEY = '__grovs_probe__';

export function getWindow(): Window | null {
  return typeof window === 'undefined' ? null : window;
}

export function getDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

export function getNavigator(): Navigator | null {
  return typeof navigator === 'undefined' ? null : navigator;
}

export function isBrowser(): boolean {
  return getWindow() !== null && getDocument() !== null;
}

/**
 * Returns the Storage object itself rather than a boolean, so callers never
 * name the global. Present-but-throwing is a real state (Safari private mode),
 * so the caller still guards each operation.
 */
export function getLocalStorage(): globalThis.Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Attempts a real write. Private browsing, disabled storage, and quota
 * exhaustion all surface as a throw rather than a falsy object, so probing by
 * capability is the only reliable test — and it retires the isElectron() user
 * agent sniff in grovs_device_details.js (spec A3).
 */
export function probeLocalStorage(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(PROBE_KEY, '1');
    localStorage.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function probeCookies(): boolean {
  const doc = getDocument();
  if (!doc) return false;
  try {
    doc.cookie = `${PROBE_KEY}=1;path=/`;
    const present = doc.cookie.includes(PROBE_KEY);
    doc.cookie = `${PROBE_KEY}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    return present;
  } catch {
    return false;
  }
}

export function getCrypto(): Crypto | null {
  try {
    return typeof crypto === 'undefined' ? null : crypto;
  } catch {
    return null;
  }
}

/**
 * The browser fingerprint the backend's authenticate endpoint accepts
 * (spec B5). v1 sent user_agent and two hardcoded "0" strings, so
 * `data_for_device` → `resolve_by_fingerprint` had almost nothing to match a
 * deferred deep link against.
 *
 * Every field is optional on the wire: a browser that blocks WebGL, or a
 * headless context with no screen, should degrade the match rather than fail
 * the request.
 */
export interface BrowserFingerprint {
  screen_width?: number;
  screen_height?: number;
  timezone?: string;
  webgl_vendor?: string;
  webgl_renderer?: string;
  language?: string;
}

export function getFingerprint(): BrowserFingerprint {
  const fingerprint: BrowserFingerprint = {};
  const win = getWindow();

  if (win?.screen) {
    if (typeof win.screen.width === 'number') fingerprint.screen_width = win.screen.width;
    if (typeof win.screen.height === 'number') fingerprint.screen_height = win.screen.height;
  }

  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) fingerprint.timezone = zone;
  } catch {
    /* Intl unavailable or the zone is undeterminable */
  }

  const language = getNavigator()?.language;
  if (language) fingerprint.language = language;

  const webgl = readWebGL();
  if (webgl.vendor) fingerprint.webgl_vendor = webgl.vendor;
  if (webgl.renderer) fingerprint.webgl_renderer = webgl.renderer;

  return fingerprint;
}

/**
 * Reads the unmasked WebGL vendor/renderer.
 *
 * Creating a canvas and a GL context is the only way to get these, and it is
 * the most expensive thing the SDK does at startup — so the result is cached
 * and the context is released immediately. Privacy-hardened browsers return
 * masked strings or refuse the extension entirely; both are handled by
 * returning nothing rather than by probing harder.
 */
let cachedWebGL: { vendor?: string; renderer?: string } | null = null;

function readWebGL(): { vendor?: string; renderer?: string } {
  if (cachedWebGL) return cachedWebGL;

  const result: { vendor?: string; renderer?: string } = {};
  const doc = getDocument();
  if (!doc) return result;

  try {
    const canvas = doc.createElement('canvas');
    const gl = (canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        const vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as unknown;
        const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as unknown;
        if (typeof vendor === 'string') result.vendor = vendor;
        if (typeof renderer === 'string') result.renderer = renderer;
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    /* no WebGL, blocked, or context creation failed */
  }

  cachedWebGL = result;
  return result;
}

/** Test seam: the WebGL read is cached for the page's lifetime. */
export function __resetFingerprintCache(): void {
  cachedWebGL = null;
}

/**
 * The IDENTIFIER header value. Spec B9: the backend compares this string
 * exactly against the linked domains configured in the console, with no
 * normalization on either side — so the format here is load-bearing.
 */
export function getPageIdentifier(): string | null {
  const win = getWindow();
  if (!win) return null;
  const { protocol, hostname, port } = win.location;
  return `${protocol}//${hostname}${port ? `:${port}` : ''}`;
}
