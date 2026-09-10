import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityStore, LINKSQUARED_STORAGE_KEY } from '../../src/storage/identity';
import { Logger } from '../../src/logging/logger';
import * as environment from '../../src/core/environment';

function clearCookies(): void {
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
  });
}

describe('IdentityStore', () => {
  beforeEach(() => {
    clearCookies();
    localStorage.clear();
  });

  it('writes to both cookie and localStorage', () => {
    new IdentityStore().set('visitor-1');
    expect(document.cookie).toContain(`${LINKSQUARED_STORAGE_KEY}=visitor-1`);
    expect(localStorage.getItem(LINKSQUARED_STORAGE_KEY)).toBe('visitor-1');
  });

  it('reads back what it wrote', () => {
    const store = new IdentityStore();
    store.set('visitor-1');
    expect(store.get()).toBe('visitor-1');
  });

  it('returns null when neither store holds a value', () => {
    expect(new IdentityStore().get()).toBeNull();
  });

  // The A3 case: Safari clamps the cookie to 7 days, so a returning visitor
  // arrives with the cookie gone and the mirror intact. Without the mirror
  // they are counted as a fresh install.
  it('recovers identity from the mirror when the cookie was evicted', () => {
    const store = new IdentityStore();
    store.set('visitor-1');

    clearCookies();
    expect(document.cookie).not.toContain('visitor-1');

    expect(store.get()).toBe('visitor-1');
  });

  it('rewrites the cookie after recovering from the mirror', () => {
    const store = new IdentityStore();
    store.set('visitor-1');
    clearCookies();

    store.get();

    expect(document.cookie).toContain(`${LINKSQUARED_STORAGE_KEY}=visitor-1`);
  });

  it('prefers the cookie when both are present', () => {
    const store = new IdentityStore();
    store.set('from-cookie');
    localStorage.setItem(LINKSQUARED_STORAGE_KEY, 'stale-mirror');
    expect(store.get()).toBe('from-cookie');
  });

  // Spec A3/T11: a cookieDomain the page host does not sit under means the
  // browser silently refuses the cookie. This is the production path — the
  // client builds its IdentityStore directly — and the report must be
  // observable with a *default-config* logger, or the diagnostic is dead in
  // exactly the installs it exists for.
  it('reports through onError when cookieDomain does not match the page host', () => {
    const logger = new Logger();
    const onError = vi.fn();
    logger.setOnError(onError);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    new IdentityStore('.mismatched.example', logger);

    expect(onError).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('.mismatched.example'),
    );
    vi.restoreAllMocks();
  });

  // The consent flow constructs IdentityStore twice against the same logger
  // (constructor, then grantConsent); one misconfiguration is one report.
  it('reports a mismatch once per logger, not once per construction', () => {
    const logger = new Logger();
    const onError = vi.fn();
    logger.setOnError(onError);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    new IdentityStore('.mismatched.example', logger);
    new IdentityStore('.mismatched.example', logger);

    expect(onError).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it('does not report when cookieDomain matches the page host', () => {
    const logger = new Logger();
    const onError = vi.fn();
    logger.setOnError(onError);

    new IdentityStore(location.hostname, logger);

    expect(onError).not.toHaveBeenCalled();
  });

  it('clears both stores', () => {
    const store = new IdentityStore();
    store.set('visitor-1');
    store.clear();
    expect(store.get()).toBeNull();
    expect(localStorage.getItem(LINKSQUARED_STORAGE_KEY)).toBeNull();
  });

  // Degradation guarantees, previously covered only through the deleted
  // resolveStorage. Spec A1 makes "does not throw during SSR" a promise.
  describe('degradation', () => {
    afterEach(() => vi.restoreAllMocks());

    it('does not throw and stays inert with no document (SSR)', () => {
      vi.spyOn(environment, 'getDocument').mockReturnValue(null);
      vi.spyOn(environment, 'getLocalStorage').mockReturnValue(null);

      const store = new IdentityStore();
      expect(() => store.set('visitor-1')).not.toThrow();
      expect(store.get()).toBeNull();
      expect(() => store.clear()).not.toThrow();
    });

    it('falls back to the mirror alone when cookies are unavailable', () => {
      vi.spyOn(environment, 'probeCookies').mockReturnValue(false);

      const store = new IdentityStore();
      store.set('visitor-1');

      expect(document.cookie).not.toContain('visitor-1');
      expect(store.get()).toBe('visitor-1');
    });

    it('keeps the cookie tier when localStorage is unavailable', () => {
      // Blocked, not merely absent: the adapter must swallow the throw.
      vi.spyOn(environment, 'getLocalStorage').mockImplementation(() => {
        throw new Error('blocked');
      });

      const store = new IdentityStore();
      store.set('visitor-1');

      expect(localStorage.getItem(LINKSQUARED_STORAGE_KEY)).toBeNull();
      expect(store.get()).toBe('visitor-1');
    });
  });
});
