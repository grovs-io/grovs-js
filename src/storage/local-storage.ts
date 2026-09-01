import { getLocalStorage } from '../core/environment';
import type { Storage } from './storage';

/**
 * Every method is guarded: Safari in private mode, quota exhaustion, and
 * enterprise policy all throw from an otherwise-present localStorage.
 *
 * The global is reached through core/environment.ts rather than named here,
 * so the A1 boundary holds for this file too.
 */
export class LocalStorageAdapter implements Storage {
  get(key: string): string | null {
    try {
      return getLocalStorage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  set(key: string, value: string): boolean {
    try {
      const store = getLocalStorage();
      if (!store) return false;
      store.setItem(key, value);
      return true;
    } catch {
      // Full, blocked, or private mode. Reported rather than swallowed: the
      // queue keeps its dirty flag set and retries on pagehide.
      return false;
    }
  }

  remove(key: string): void {
    try {
      getLocalStorage()?.removeItem(key);
    } catch {
      /* as above */
    }
  }
}
