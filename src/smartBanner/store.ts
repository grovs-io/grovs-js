import { getSessionStorage } from '../core/environment';
import type { Storage } from '../storage/storage';
import { isHttpUrl, parseBanners, type SmartBannerConfig } from './types';

export const DISMISSED_KEY = 'grovs_smart_banner_dismissed';
const SESSION_PREFIX = 'grovs_sb:';
export const LIST_TTL_MS = 10 * 60 * 1000;
export const FAIL_BACKOFF_MS = 60 * 1000;
export const LINK_CAP = 50;
const DAY_MS = 86_400_000;

export class BannerStore {
  /** Dismissals for the current page view only; cleared on route change and stop. */
  private readonly suppressed = new Set<number>();

  constructor(
    private readonly bulk: Storage,
    private readonly scope: string,
    private readonly now: () => number,
  ) {}

  isDismissed(banner: SmartBannerConfig): boolean {
    if (this.suppressed.has(banner.id)) return true;
    const record = this.dismissals()[String(banner.id)] as { at?: unknown; days?: unknown } | undefined;
    if (!record || typeof record.at !== 'number' || typeof record.days !== 'number') return false;
    return this.now() - record.at < record.days * DAY_MS;
  }

  /** Caller passes dismiss_days (close) or open_hide_days (click); 0 hides this page view only. */
  dismiss(id: number, days: number): void {
    this.suppressed.add(id);
    if (days <= 0) return;
    const all = this.dismissals();
    all[String(id)] = { at: this.now(), days };
    this.bulk.set(DISMISSED_KEY, JSON.stringify(all));
  }

  clearPageView(): void {
    this.suppressed.clear();
  }

  /** The raw wire body is cached and re-parsed: the host page can write session storage. */
  /** `stale` also returns an expired list: the last good one, while requests fail. */
  cachedBanners(stale = false): SmartBannerConfig[] | null {
    const cached = this.read<{ at?: unknown; body?: unknown }>('list');
    if (!cached || typeof cached.at !== 'number' || (!stale && this.now() - cached.at > LIST_TTL_MS)) return null;
    return parseBanners(cached.body);
  }

  cacheBanners(body: unknown): void {
    this.write('list', { at: this.now(), body });
  }

  cachedLink(id: number, key: string): string | null {
    const link = this.read<unknown>(`link:${id}:${key}`);
    return isHttpUrl(link) ? link : null;
  }

  /** Keeps the LINK_CAP most recent links. */
  cacheLink(id: number, key: string, link: string): void {
    const name = `link:${id}:${key}`;
    const index = this.read<unknown>('links');
    const names = (Array.isArray(index) ? index : []).filter((n) => n !== name);
    names.push(name);
    for (const old of names.splice(0, names.length - LINK_CAP)) this.remove(String(old));
    this.write('links', names);
    this.write(name, link);
  }

  /** A list or link request failed within the last minute, or a Retry-After holds, on this or an earlier page load. */
  backingOff(): boolean {
    const at = this.read<unknown>('fail');
    const until = this.read<unknown>('hold');
    return (typeof at === 'number' && this.now() - at < FAIL_BACKOFF_MS) || (typeof until === 'number' && this.now() < until);
  }

  /** A Retry-After over 60 s is a deadline that a later success does not clear. */
  noteFailure(failed: boolean, retryAfterMs = 0): void {
    if (retryAfterMs > FAIL_BACKOFF_MS) this.write('hold', this.now() + retryAfterMs);
    if (failed) this.write('fail', this.now());
    else if (this.read('fail') !== null) this.write('fail', 0);
  }

  clearSession(): void {
    const session = getSessionStorage();
    if (!session) return;
    try {
      const prefix = `${SESSION_PREFIX}${this.scope}:`;
      const doomed: string[] = [];
      for (let i = 0; i < session.length; i += 1) {
        const key = session.key(i);
        if (key?.startsWith(prefix)) doomed.push(key);
      }
      for (const key of doomed) session.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }

  private dismissals(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.bulk.get(DISMISSED_KEY) ?? '{}');
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private read<T>(name: string): T | null {
    try {
      const raw = getSessionStorage()?.getItem(`${SESSION_PREFIX}${this.scope}:${name}`);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private remove(name: string): void {
    try {
      getSessionStorage()?.removeItem(`${SESSION_PREFIX}${this.scope}:${name}`);
    } catch {
      /* storage unavailable */
    }
  }

  private write(name: string, value: unknown): void {
    try {
      getSessionStorage()?.setItem(`${SESSION_PREFIX}${this.scope}:${name}`, JSON.stringify(value));
    } catch {
      /* quota or disabled storage: the cache is an optimisation */
    }
  }
}
