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

  set(key: string, value: string): void {
    try {
      getLocalStorage()?.setItem(key, value);
    } catch {
      /* storage full or blocked — the caller cannot act on this */
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
