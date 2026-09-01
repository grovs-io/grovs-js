export interface Storage {
  get(key: string): string | null;
  /** False when the store refused the write, so callers can retry. */
  set(key: string, value: string): boolean;
  remove(key: string): void;
}
