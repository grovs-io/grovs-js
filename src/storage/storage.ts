import { probeCookies, probeLocalStorage, getDocument } from '../core/environment';
import type { Logger } from '../logging/logger';
import { CookieStorage } from './cookie-storage';
import { LocalStorageAdapter } from './local-storage';
import { MemoryStorage } from './memory-storage';

export interface Storage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * Picks a backing store by capability, never by user agent (spec A3).
 *
 * Cookie first, because the linksquared identifier has always lived there and
 * changing that would orphan every existing visitor. localStorage second, so
 * Electron and cookie-blocked contexts still persist. Memory last, so the SDK
 * degrades instead of throwing.
 */
export function resolveStorage(logger: Logger, cookieDomain?: string): Storage {
  const doc = getDocument();
  if (doc && probeCookies()) return new CookieStorage(doc, cookieDomain, logger);
  if (probeLocalStorage()) {
    logger.info('Cookies unavailable; falling back to localStorage.');
    return new LocalStorageAdapter();
  }
  logger.warn('No persistent storage available; identity will not survive reload.');
  return new MemoryStorage();
}
