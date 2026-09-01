import type { Storage } from './storage';

export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, value: string): boolean {
    this.map.set(key, value);
    return true;
  }

  remove(key: string): void {
    this.map.delete(key);
  }
}
