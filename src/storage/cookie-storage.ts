import type { Logger } from '../logging/logger';
import { GrovsError } from '../net/errors';
import type { Storage } from './storage';

/** Matches v1's far-future expiry. Safari's ITP clamps this to 7 days; spec A3
 *  covers the localStorage mirror that compensates, which lands in Phase 1. */
const FAR_FUTURE = new Date('9999-12-31').toUTCString();

export class CookieStorage implements Storage {
  constructor(
    private readonly doc: Document,
    private readonly domain?: string,
    logger?: Logger,
  ) {
    if (domain && logger) {
      const host = this.doc.location?.hostname ?? '';
      const bare = domain.startsWith('.') ? domain.slice(1) : domain;
      if (host !== bare && !host.endsWith(`.${bare}`)) {
        // Fatal-but-silent config error, same class as the B9 linked-domain
        // 422: identity stops persisting and every visit counts as a new
        // install. reportErrorOnce so it survives the default 'error' level
        // and reaches onError — a warn() is filtered out for every integrator
        // who has not opted into debugLevel: 'warn'. authenticationFailed is
        // the closest of the four contract codes (spec A5), matching B9.
        logger.reportErrorOnce(
          'cookieDomain',
          GrovsError.authenticationFailed,
          `cookieDomain "${domain}" does not match the page host "${host}". ` +
            'The browser will silently refuse the cookie and identity will not persist.',
        );
      }
    }
  }

  get(key: string): string | null {
    const cookies = this.doc.cookie ? this.doc.cookie.split(';') : [];
    for (const cookie of cookies) {
      const trimmed = cookie.trim();
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      if (trimmed.slice(0, eq) !== key) continue;
      // A value the SDK did not write can be undecodable; treating it as
      // absent lets the localStorage mirror take over instead of the throw
      // taking the constructor down.
      try {
        return decodeURIComponent(trimmed.slice(eq + 1));
      } catch {
        continue;
      }
    }
    return null;
  }

  set(key: string, value: string): boolean {
    let encoded: string;
    try {
      encoded = encodeURIComponent(value);
    } catch {
      return false;
    }
    const parts = [
      `${key}=${encoded}`,
      `expires=${FAR_FUTURE}`,
      'path=/',
      // Not Strict: the identifier must survive a Grovs link's cross-site redirect.
      'SameSite=Lax',
    ];
    // Secure on http is refused outright, which would break local development.
    if (this.doc.location?.protocol === 'https:') parts.push('Secure');
    // Spec T11: v1 wrote no domain attribute, so the cookie was host-only.
    // Auto-detecting the registrable domain needs the Public Suffix List,
    // which the bundle budget rules out — the integrator opts in instead.
    if (this.domain) parts.push(`domain=${this.domain}`);
    this.doc.cookie = parts.join(';');
    // Assignment never throws, so a read-back is the only way to see a cookie
    // the browser refused — an oversized value or a mismatched domain.
    return this.get(key) === value;
  }

  remove(key: string): void {
    const parts = [`${key}=`, 'expires=Thu, 01 Jan 1970 00:00:00 GMT', 'path=/'];
    this.doc.cookie = parts.join(';');
    // Both scopes: a v1 host-only cookie can sit beside the domain one, and
    // browsers return the older one first — an id removed only from the
    // domain scope would read back as erased-and-still-there.
    if (this.domain) this.doc.cookie = [...parts, `domain=${this.domain}`].join(';');
  }
}
