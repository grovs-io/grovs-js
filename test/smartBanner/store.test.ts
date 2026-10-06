import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BannerStore, DISMISSED_KEY } from '../../src/smartBanner/store';
import { FakeStorage } from '../helpers/fake-storage';
import { RAW_BANNER, bannerConfig } from './fixtures';

const DAY = 86_400_000;
const banner = bannerConfig();
const BODY = { smart_banners: [RAW_BANNER] };

describe('BannerStore', () => {
  let now = 1_000_000;
  let bulk: FakeStorage;
  let store: BannerStore;

  beforeEach(() => {
    sessionStorage.clear();
    now = 1_000_000;
    bulk = new FakeStorage();
    store = new BannerStore(bulk, 'proj', () => now);
  });

  it('persists a failure backoff in sessionStorage for 60 s, cleared on success or clearSession', () => {
    expect(store.backingOff()).toBe(false);
    store.noteFailure(true);
    const reloaded = new BannerStore(new FakeStorage(), 'proj', () => now);
    now += 59_999;
    expect(reloaded.backingOff()).toBe(true);
    now += 1;
    expect(reloaded.backingOff()).toBe(false);

    store.noteFailure(true);
    store.noteFailure(false);
    expect(store.backingOff()).toBe(false);
    store.noteFailure(true);
    store.clearSession();
    expect(store.backingOff()).toBe(false);
  });

  it('holds a Retry-After over 60 s across page loads, even after a success', () => {
    store.noteFailure(true, 120_000);
    store.noteFailure(false);
    const reloaded = new BannerStore(new FakeStorage(), 'proj', () => now);
    now += 119_999;
    expect(reloaded.backingOff()).toBe(true);
    now += 1;
    expect(reloaded.backingOff()).toBe(false);
  });

  it('keeps the 50 most recently cached links', () => {
    for (let i = 0; i < 50; i += 1) store.cacheLink(1, `k${i}`, `https://go.example.com/${i}`);
    store.cacheLink(1, 'k0', 'https://go.example.com/0');
    store.cacheLink(1, 'k50', 'https://go.example.com/50');
    expect(store.cachedLink(1, 'k0')).toBe('https://go.example.com/0');
    expect(store.cachedLink(1, 'k1')).toBeNull();
    expect(store.cachedLink(1, 'k50')).toBe('https://go.example.com/50');
    expect(Object.keys(sessionStorage).filter((k) => k.includes(':link:'))).toHaveLength(50);
  });

  it('remembers a dismissal for dismiss_days, then lets it expire', () => {
    store.dismiss(banner.id, banner.dismissDays);
    expect(JSON.parse(bulk.get(DISMISSED_KEY)!)).toEqual({ '1': { at: 1_000_000, days: 7 } });
    store.clearPageView();
    now += 7 * DAY - 1;
    expect(store.isDismissed(banner)).toBe(true);
    now += 1;
    expect(store.isDismissed(banner)).toBe(false);
  });

  it('remembers a hide for open_hide_days, then lets it expire', () => {
    const opened = bannerConfig({ openHideDays: 10 });
    store.dismiss(opened.id, opened.openHideDays);
    store.clearPageView();
    now += 10 * DAY - 1;
    expect(store.isDismissed(opened)).toBe(true);
    now += 1;
    expect(store.isDismissed(opened)).toBe(false);
  });

  it('a new page load honours only the stored timestamp', () => {
    store.dismiss(banner.id, banner.dismissDays);
    const later = new BannerStore(bulk, 'proj', () => now);
    now += 7 * DAY;
    expect(later.isDismissed(banner)).toBe(false);
  });

  it('keeps a dismissal for the page view when storage refuses writes', () => {
    bulk.failWrites = true;
    store.dismiss(banner.id, banner.dismissDays);
    expect(store.isDismissed(banner)).toBe(true);
    store.clearPageView();
    expect(store.isDismissed(banner)).toBe(false);
  });

  it('treats dismiss_days 0 as this page view only', () => {
    const once = bannerConfig({ dismissDays: 0 });
    store.dismiss(once.id, once.dismissDays);
    expect(bulk.get(DISMISSED_KEY)).toBeNull();
    expect(store.isDismissed(once)).toBe(true);
    store.clearPageView();
    expect(store.isDismissed(once)).toBe(false);
  });

  it('treats open_hide_days 0 as this page view only', () => {
    const once = bannerConfig({ openHideDays: 0 });
    store.dismiss(once.id, once.openHideDays);
    expect(bulk.get(DISMISSED_KEY)).toBeNull();
    expect(store.isDismissed(once)).toBe(true);
    store.clearPageView();
    expect(store.isDismissed(once)).toBe(false);
  });

  it('survives a corrupt dismissal record', () => {
    bulk.set(DISMISSED_KEY, '{nope');
    expect(store.isDismissed(banner)).toBe(false);
  });

  it('caches the banner list for 10 minutes', () => {
    store.cacheBanners(BODY);
    expect(store.cachedBanners()).toEqual([banner]);
    now += 10 * 60 * 1000 + 1;
    expect(store.cachedBanners()).toBeNull();
  });

  it('re-validates cached entries the host page could have changed', () => {
    const hostile = { ...RAW_BANNER, id: 2, default_link: 'javascript:alert(1)' };
    sessionStorage.setItem(
      'grovs_sb:proj:list',
      JSON.stringify({ at: now, body: { smart_banners: [hostile, RAW_BANNER] } }),
    );
    expect(store.cachedBanners()?.map((b) => b.id)).toEqual([1]);
    sessionStorage.setItem('grovs_sb:proj:list', JSON.stringify({ at: 'soon', body: BODY }));
    expect(store.cachedBanners()).toBeNull();
    sessionStorage.setItem('grovs_sb:proj:link:1:k', JSON.stringify('javascript:alert(1)'));
    expect(store.cachedLink(1, 'k')).toBeNull();
  });

  it('caches links per banner and payload key', () => {
    store.cacheLink(1, '{"page_path":"/a"}', 'https://go.example.com/a');
    expect(store.cachedLink(1, '{"page_path":"/a"}')).toBe('https://go.example.com/a');
    expect(store.cachedLink(1, '{"page_path":"/b"}')).toBeNull();
    expect(store.cachedLink(2, '{"page_path":"/a"}')).toBeNull();
  });

  it('clears only its own session keys', () => {
    sessionStorage.setItem('other', 'x');
    store.cacheBanners(BODY);
    store.cacheLink(1, 'k', 'https://go.example.com/a');
    store.clearSession();
    expect(store.cachedBanners()).toBeNull();
    expect(store.cachedLink(1, 'k')).toBeNull();
    expect(sessionStorage.getItem('other')).toBe('x');
  });

  it('works when sessionStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => store.cacheBanners(BODY)).not.toThrow();
    expect(store.cachedBanners()).toBeNull();
    expect(store.cachedLink(1, 'k')).toBeNull();
  });
});
