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
