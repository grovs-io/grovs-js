import { getDocument, probeCookies, probeLocalStorage } from '../core/environment';
import type { Logger } from '../logging/logger';
import { CookieStorage } from './cookie-storage';
import { LocalStorageAdapter } from './local-storage';
import type { Storage } from './storage';

export const LINKSQUARED_STORAGE_KEY = 'linksquared';

/**
 * The visitor identifier, mirrored across cookie and localStorage (spec A3).
 *
 * Safari's ITP clamps any cookie written through document.cookie to 7 days
 * regardless of the expiry requested — v1 asked for the year 9999
 * (grovs_device_details.js:74) and got a week. Because install-versus-reinstall
 * is decided by whether an identifier exists, a cookie-only identity reports a
 * fresh `install` for every Safari visitor returning after a week: permanently,
 * invisibly, and in the direction that flatters the numbers.
 *
 * Reads prefer the cookie and fall back to the mirror, rewriting the cookie
 * when only the mirror survived. This does not defeat ITP — Safari can also
 * evict script-writable storage after 7 days without user interaction — but it
 * covers the visitor who has used the site recently, which is most of them.
 * The residual limitation belongs in the README, not in a comment nobody reads.
 */
export class IdentityStore {
  private readonly cookie: Storage | null;
  private readonly mirror: Storage | null;

  constructor(cookieDomain?: string, logger?: Logger) {
    const doc = getDocument();
    this.cookie = doc && probeCookies() ? new CookieStorage(doc, cookieDomain, logger) : null;
    this.mirror = probeLocalStorage() ? new LocalStorageAdapter() : null;
  }

  get(): string | null {
    const fromCookie = this.cookie?.get(LINKSQUARED_STORAGE_KEY) ?? null;
    if (fromCookie) return fromCookie;

    const fromMirror = this.mirror?.get(LINKSQUARED_STORAGE_KEY) ?? null;
    if (fromMirror) {
      // The cookie was evicted but the mirror survived: restore it, so the
      // next read is a cookie hit and the two stay in step.
      this.cookie?.set(LINKSQUARED_STORAGE_KEY, fromMirror);
    }
    return fromMirror;
  }

  set(value: string): void {
    this.cookie?.set(LINKSQUARED_STORAGE_KEY, value);
    this.mirror?.set(LINKSQUARED_STORAGE_KEY, value);
  }

  clear(): void {
    this.cookie?.remove(LINKSQUARED_STORAGE_KEY);
    this.mirror?.remove(LINKSQUARED_STORAGE_KEY);
  }
}
