import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CookieStorage } from '../../src/storage/cookie-storage';
import { MemoryStorage } from '../../src/storage/memory-storage';
import { LocalStorageAdapter } from '../../src/storage/local-storage';
import { Logger } from '../../src/logging/logger';

describe('MemoryStorage', () => {
  it('round-trips and removes values', () => {
    const s = new MemoryStorage();
    expect(s.get('k')).toBeNull();
    s.set('k', 'v');
    expect(s.get('k')).toBe('v');
    s.remove('k');
    expect(s.get('k')).toBeNull();
  });
});

describe('LocalStorageAdapter', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips values', () => {
    const s = new LocalStorageAdapter();
    s.set('k', 'v');
    expect(s.get('k')).toBe('v');
    s.remove('k');
    expect(s.get('k')).toBeNull();
  });

  it('returns null rather than throwing when the backing store fails', () => {
    const s = new LocalStorageAdapter();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(s.get('k')).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('CookieStorage', () => {
  beforeEach(() => {
    document.cookie.split(';').forEach((c) => {
      const name = c.split('=')[0]?.trim();
      if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    });
  });

  it('round-trips values', () => {
    const s = new CookieStorage(document);
    s.set('grovs_id', 'abc123');
    expect(s.get('grovs_id')).toBe('abc123');
  });

  it('decodes encoded values', () => {
    const s = new CookieStorage(document);
    s.set('k', 'a b&c');
    expect(s.get('k')).toBe('a b&c');
  });

  it('returns null for an absent key', () => {
    const s = new CookieStorage(document);
    expect(s.get('nope')).toBeNull();
  });

  it('does not match a key that is a prefix of another', () => {
    const s = new CookieStorage(document);
    s.set('grovs_id_extra', 'wrong');
    expect(s.get('grovs_id')).toBeNull();
  });

  it('writes no domain attribute by default, matching v1', () => {
    const doc = { cookie: '' } as Document;
    const s = new CookieStorage(doc);
    s.set('k', 'v');
    expect(doc.cookie).not.toContain('domain=');
  });

  it('expires the cookie on remove', () => {
    const s = new CookieStorage(document);
    s.set('grovs_id', 'abc123');
    expect(s.get('grovs_id')).toBe('abc123');
    s.remove('grovs_id');
    expect(s.get('grovs_id')).toBeNull();
  });

  it('scopes the removal to cookieDomain when one is set', () => {
    const doc = { cookie: '' } as Document;
    const s = new CookieStorage(doc, '.example.com');
    s.remove('k');
    expect(doc.cookie).toContain('domain=.example.com');
    expect(doc.cookie).toContain('01 Jan 1970');
  });

  it('writes a domain attribute when cookieDomain is set', () => {
    const doc = { cookie: '' } as Document;
    const s = new CookieStorage(doc, '.example.com');
    s.set('k', 'v');
    expect(doc.cookie).toContain('domain=.example.com');
  });

  it('warns when cookieDomain does not match the page host', () => {
    const logger = new Logger();
    logger.setLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new CookieStorage(document, '.other-site.com', logger);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain('other-site.com');
    vi.restoreAllMocks();
  });

  it('does not warn when cookieDomain matches the page host', () => {
    const logger = new Logger();
    logger.setLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new CookieStorage(document, 'localhost', logger);
    expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
