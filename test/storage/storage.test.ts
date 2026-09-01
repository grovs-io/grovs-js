import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CookieStorage } from '../../src/storage/cookie-storage';
import { MemoryStorage } from '../../src/storage/memory-storage';
import { LocalStorageAdapter } from '../../src/storage/local-storage';
import { Logger } from '../../src/logging/logger';
import { GrovsError } from '../../src/net/errors';
import { PersistedQueue, QUEUE_STORAGE_KEY } from '../../src/storage/persisted-queue';
import { FakeStorage } from '../helpers/fake-storage';
import { FakeClock } from '../helpers/fake-clock';

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

describe('PersistedQueue write failures', () => {
  it('stays dirty when the store refuses the write, and retries on pagehide', () => {
    vi.useFakeTimers();
    const storage = new FakeStorage();
    const queue = new PersistedQueue(storage, new FakeClock());

    storage.failWrites = true;
    queue.add({ id: 'a', event: 'app_open', createdAt: 1, sessionId: 's' });
    vi.advanceTimersByTime(1100);
    expect(storage.get(QUEUE_STORAGE_KEY)).toBeNull();

    // Whatever blocked the write has cleared.
    storage.failWrites = false;
    queue.flushToStorage();

    const persisted = storage.get(QUEUE_STORAGE_KEY);
    expect(persisted).not.toBeNull();
    expect(persisted).toContain('app_open');
    vi.useRealTimers();
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

  it('reports success by reading the value back', () => {
    expect(new CookieStorage(document).set('grovs_ok', 'v')).toBe(true);
  });

  it('reports failure when the browser refuses the cookie', () => {
    const doc = {
      get cookie() {
        return '';
      },
      set cookie(_value: string) {
        /* refused, as for an oversized value or a mismatched domain */
      },
    } as Document;
    expect(new CookieStorage(doc).set('k', 'v')).toBe(false);
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

  it('states SameSite=Lax rather than relying on the browser default', () => {
    const doc = { cookie: '', location: { protocol: 'https:' } } as Document;
    new CookieStorage(doc).set('k', 'v');
    expect(doc.cookie).toContain('SameSite=Lax');
  });

  it('marks the cookie Secure on an https origin', () => {
    const doc = { cookie: '', location: { protocol: 'https:' } } as Document;
    new CookieStorage(doc).set('k', 'v');
    expect(doc.cookie).toContain('Secure');
  });

  it('omits Secure when the document exposes no location', () => {
    const doc = { cookie: '' } as Document;
    new CookieStorage(doc).set('k', 'v');
    expect(doc.cookie).not.toContain('Secure');
  });

  it('omits Secure on an http origin so local development still persists', () => {
    const doc = { cookie: '', location: { protocol: 'http:' } } as Document;
    const s = new CookieStorage(doc);
    s.set('k', 'v');
    expect(doc.cookie).not.toContain('Secure');
    expect(doc.cookie).toContain('SameSite=Lax');
  });

  // A mismatched cookieDomain means the browser silently refuses the cookie
  // and identity does not persist — the fatal-but-silent config error class
  // of spec A5. It must surface at the *default* level and through onError,
  // like its B9 linked-domain sibling; a warn() would be filtered out for
  // every integrator who has not opted into debugLevel: 'warn'.
  it('reports through onError when cookieDomain does not match the page host', () => {
    const logger = new Logger();
    const onError = vi.fn();
    logger.setOnError(onError);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    new CookieStorage(document, '.other-site.com', logger);

    expect(onError).toHaveBeenCalledWith(
      GrovsError.authenticationFailed,
      expect.stringContaining('other-site.com'),
    );
    expect(consoleSpy).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it('does not report when cookieDomain matches the page host', () => {
    const logger = new Logger();
    const onError = vi.fn();
    logger.setOnError(onError);

    new CookieStorage(document, 'localhost', logger);

    expect(onError).not.toHaveBeenCalled();
  });
});
