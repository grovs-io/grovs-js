import type { Storage } from '../../src/storage/storage';

/** In-memory Storage with failure injection, for tests that need to prove
 *  the SDK survives a store that stops working mid-session. */
export class FakeStorage implements Storage {
  readonly map = new Map<string, string>();
  failWrites = false;

  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, value: string): void {
    if (this.failWrites) return;
    this.map.set(key, value);
  }

  remove(key: string): void {
    this.map.delete(key);
  }
}
