import { probeLocalStorage } from '../core/environment';
import type { Logger } from '../logging/logger';
import { LocalStorageAdapter } from './local-storage';
import { MemoryStorage } from './memory-storage';
import type { Storage } from './storage';

/**
 * Storage for bulk data: the event queue, the session, the captured deep link
 * path, and the open counters. **Never a cookie.**
 *
 * Browsers cap a single cookie at roughly 4 KB and silently ignore an
 * oversized `document.cookie` assignment — no exception is thrown, so the
 * write simply does not happen. A queue of ~25 events already exceeds that,
 * which would make the 1,000-event cap, oldest-first eviction and 7-day TTL
 * all operate on something that can never be persisted. Events would survive
 * in memory only and a reload would lose them, which is most of what the
 * event pipeline exists to fix.
 *
 * jsdom enforces no cookie size limit, so a unit test cannot catch this. That
 * is precisely why the choice is made here, by type, rather than left to a
 * general-purpose resolver.
 *
 * The visitor identifier is the opposite case and uses IdentityStore: small,
 * and it needs the cookie to survive alongside the localStorage mirror.
 */
export function resolveBulkStorage(logger: Logger): Storage {
  if (probeLocalStorage()) return new LocalStorageAdapter();
  logger.warn(
    'localStorage is unavailable; queued events and session state will not survive a reload.',
  );
  return new MemoryStorage();
}

/**
 * A stable Storage reference whose backing store can be swapped once.
 *
 * Consent mode starts everything in memory. Handing collaborators this
 * indirection rather than the store itself means granting consent repoints
 * one object instead of migrating each holder — and a holder that was
 * constructed with the original store cannot be silently left behind on it,
 * which is exactly the bug this replaces.
 */
export class SwitchableStorage implements Storage {
  constructor(private target: Storage) {}

  get(key: string): string | null {
    return this.target.get(key);
  }

  set(key: string, value: string): boolean {
    return this.target.set(key, value);
  }

  remove(key: string): void {
    this.target.remove(key);
  }

  /** Repoints at `next`, carrying the named keys across. */
  switchTo(next: Storage, keys: readonly string[]): void {
    if (next === this.target) return;
    for (const key of keys) {
      const value = this.target.get(key);
      if (value !== null) next.set(key, value);
    }
    this.target = next;
  }

  /** Test seam. */
  get backing(): Storage {
    return this.target;
  }
}
