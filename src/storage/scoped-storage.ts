import type { Storage } from './storage';

/**
 * Prefix-namespaces every key with the project the client was configured
 * for. Bulk state — the queue, the session, the counters, the captured path —
 * is per project: without this, events queued under one project key on an
 * origin were sent under the next project configured there, and switching
 * testEnvironment did the same between test and production.
 *
 * The visitor identifier is deliberately not scoped: it is the one key v1
 * wrote, and a returning visitor must be recognised across the upgrade.
 */
export class ScopedStorage implements Storage {
  constructor(
    private readonly inner: Storage,
    private readonly scope: string,
  ) {}

  get(key: string): string | null {
    return this.inner.get(scopedKey(key, this.scope));
  }

  set(key: string, value: string): boolean {
    return this.inner.set(scopedKey(key, this.scope), value);
  }

  remove(key: string): void {
    this.inner.remove(scopedKey(key, this.scope));
  }
}

export function scopedKey(key: string, scope: string): string {
  return `${key}:${scope}`;
}
