import { beforeEach, describe, expect, it } from 'vitest';
import { IdentityStore, LINKSQUARED_STORAGE_KEY } from '../../src/storage/identity';

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

  it('clears both stores', () => {
    const store = new IdentityStore();
    store.set('visitor-1');
    store.clear();
    expect(store.get()).toBeNull();
    expect(localStorage.getItem(LINKSQUARED_STORAGE_KEY)).toBeNull();
  });
});
