import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStorage } from '../../src/storage/storage';
import { CookieStorage } from '../../src/storage/cookie-storage';
import { LocalStorageAdapter } from '../../src/storage/local-storage';
import { MemoryStorage } from '../../src/storage/memory-storage';
import { Logger } from '../../src/logging/logger';
import * as environment from '../../src/core/environment';

describe('resolveStorage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefers cookies, where the linksquared identifier has always lived', () => {
    vi.spyOn(environment, 'probeCookies').mockReturnValue(true);
    expect(resolveStorage(new Logger())).toBeInstanceOf(CookieStorage);
  });

  it('falls back to localStorage when cookies are unavailable', () => {
    vi.spyOn(environment, 'probeCookies').mockReturnValue(false);
    vi.spyOn(environment, 'probeLocalStorage').mockReturnValue(true);
    expect(resolveStorage(new Logger())).toBeInstanceOf(LocalStorageAdapter);
  });

  it('degrades to memory rather than throwing when nothing persists', () => {
    vi.spyOn(environment, 'probeCookies').mockReturnValue(false);
    vi.spyOn(environment, 'probeLocalStorage').mockReturnValue(false);
    expect(resolveStorage(new Logger())).toBeInstanceOf(MemoryStorage);
  });

  it('warns when no persistent storage is available', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(environment, 'probeCookies').mockReturnValue(false);
    vi.spyOn(environment, 'probeLocalStorage').mockReturnValue(false);
    const logger = new Logger();
    logger.setLevel('warn');

    resolveStorage(logger);

    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toContain('not survive reload');
  });

  it('uses memory during server rendering, where there is no document', () => {
    vi.spyOn(environment, 'getDocument').mockReturnValue(null);
    vi.spyOn(environment, 'probeLocalStorage').mockReturnValue(false);
    expect(resolveStorage(new Logger())).toBeInstanceOf(MemoryStorage);
  });

  it('passes cookieDomain through to the cookie store', () => {
    vi.spyOn(environment, 'probeCookies').mockReturnValue(true);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logger = new Logger();
    logger.setLevel('warn');

    resolveStorage(logger, '.mismatched.example');

    // The mismatch warning proves the domain reached CookieStorage.
    expect(String(spy.mock.calls[0]?.[0])).toContain('mismatched.example');
  });
});
