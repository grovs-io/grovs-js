import { describe, expect, it } from 'vitest';
import { parseBanners } from '../../src/smartBanner/types';
import { detectPlatform } from '../../src/smartBanner/platform';
import { currentRoute, matchesPattern, normalizePath, selectBanner } from '../../src/smartBanner/match';
import { buildPayload } from '../../src/smartBanner/link-data';
import { RAW_BANNER, bannerConfig as banner } from './fixtures';

/** Data whose stored payload with page_path '/x' is exactly `bytes` long (ASCII). */
function dataOfSize(bytes: number): Record<string, string> {
  const data: Record<string, string> = {};
  for (let i = 0; i < 10; i += 1) data[`k${i}`] = '';
  let remaining = bytes - JSON.stringify({ page_path: '/x', ...data }).length;
  for (let i = 0; i < 10 && remaining > 0; i += 1) {
    const take = Math.min(512, remaining);
    data[`k${i}`] = 'x'.repeat(take);
    remaining -= take;
  }
  return data;
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';

describe('parseBanners', () => {
  it('maps the wire shape', () => {
    expect(parseBanners({ smart_banners: [RAW_BANNER] })).toEqual([
      {
        id: 1,
        platforms: ['ios', 'android'],
        urlInclude: [],
        urlExclude: [],
        position: 'top',
        title: 'Get the app',
        subtitle: 'Faster checkout',
        buttonText: 'Open',
        backgroundColor: '#ffffff',
        textColor: '#111111',
        buttonColor: '#4f46e5',
        buttonTextColor: '#ffffff',
        iconUrl: 'https://cdn.example.com/icon.png',
        dismissDays: 7,
        openHideDays: 30,
        defaultLink: 'https://go.example.com/default',
      },
    ]);
  });

  it('defaults open_hide_days to 30 when missing or invalid', () => {
    const cases = [undefined, 400, -1, 1.5, '10'];
    for (const open_hide_days of cases) {
      const [parsed] = parseBanners({ smart_banners: [{ ...RAW_BANNER, open_hide_days }] });
      expect(parsed?.openHideDays).toBe(30);
    }
  });

  it('parses a valid open_hide_days, including the 0 and 365 boundaries', () => {
    const [zero] = parseBanners({ smart_banners: [{ ...RAW_BANNER, open_hide_days: 0 }] });
    expect(zero?.openHideDays).toBe(0);
    const [max] = parseBanners({ smart_banners: [{ ...RAW_BANNER, open_hide_days: 365 }] });
    expect(max?.openHideDays).toBe(365);
  });

  it('drops malformed entries and keeps the rest', () => {
    const bad = { ...RAW_BANNER, id: 2, background_color: 'red' };
    const noLink = { ...RAW_BANNER, id: 3, default_link: 'javascript:alert(1)' };
    expect(parseBanners({ smart_banners: [bad, noLink, RAW_BANNER] }).map((b) => b.id)).toEqual([1]);
  });

  it('returns nothing for a body without a list', () => {
    expect(parseBanners(null)).toEqual([]);
    expect(parseBanners({ smart_banners: 'x' })).toEqual([]);
  });

  it('drops a non-http icon rather than the banner', () => {
    const [parsed] = parseBanners({ smart_banners: [{ ...RAW_BANNER, icon_url: 'data:x' }] });
    expect(parsed?.iconUrl).toBeNull();
  });
});

describe('detectPlatform', () => {
  it('detects iOS, iPadOS and Android', () => {
    expect(detectPlatform(IPHONE, 5)).toBe('ios');
    expect(detectPlatform(IPAD_DESKTOP, 5)).toBe('ios');
    expect(detectPlatform(ANDROID, 5)).toBe('android');
  });

  it('shows nothing on desktop, including a Mac without touch', () => {
    expect(detectPlatform(DESKTOP, 0)).toBeNull();
    expect(detectPlatform(IPAD_DESKTOP, 0)).toBeNull();
  });
});

describe('matching', () => {
  it('normalizes case and trailing slashes', () => {
    expect(normalizePath('/Products/')).toBe('/products');
    expect(normalizePath('/')).toBe('/');
  });

  it('lets * cross /', () => {
    expect(matchesPattern('/products/*', '/products/a/b')).toBe(true);
    expect(matchesPattern('/products/*', '/blog/a')).toBe(false);
  });

  it('ignores case and trailing slashes on both sides', () => {
    expect(matchesPattern('/Blog/', '/blog')).toBe(true);
    expect(matchesPattern('/blog', '/BLOG/')).toBe(true);
  });

  it('matches on the decoded pathname', () => {
    expect(normalizePath('/Caf%C3%A9/')).toBe('/café');
    expect(matchesPattern('/café/*', '/caf%C3%A9/menu')).toBe(true);
  });

  it('falls back to the raw path when it cannot be decoded', () => {
    expect(normalizePath('/bad%E0%A4%A')).toBe('/bad%e0%a4%a');
    expect(() => matchesPattern('/bad*', '/bad%E0%A4%A')).not.toThrow();
    expect(matchesPattern('/bad*', '/bad%E0%A4%A')).toBe(true);
  });

  it('treats regex characters literally', () => {
    expect(matchesPattern('/a.b', '/axb')).toBe(false);
    expect(matchesPattern('/a.b', '/a.b')).toBe(true);
  });

  it('picks the first eligible banner in priority order', () => {
    const iosOnly = banner({ id: 1, platforms: ['ios'] });
    const products = banner({ id: 2, urlInclude: ['/products/*'] });
    const all = banner({ id: 3 });
    const list = [iosOnly, products, all];
    const never = () => false;
    expect(selectBanner(list, 'android', '/products/1', never)?.id).toBe(2);
    expect(selectBanner(list, 'android', '/blog', never)?.id).toBe(3);
    expect(selectBanner(list, 'ios', '/blog', never)?.id).toBe(1);
  });

  it('honours excludes and dismissals', () => {
    const excluded = banner({ id: 1, urlExclude: ['/checkout*'] });
    const fallback = banner({ id: 2 });
    expect(selectBanner([excluded, fallback], 'ios', '/checkout/pay', () => false)?.id).toBe(2);
    expect(selectBanner([excluded, fallback], 'ios', '/home', (b) => b.id === 1)?.id).toBe(2);
    expect(selectBanner([excluded], 'ios', '/checkout', () => false)).toBeNull();
  });
});

describe('currentRoute', () => {
  const route = (pathname: string, hash: string) => currentRoute({ pathname, hash });

  it('reads the route from a #/ or #!/ hash', () => {
    expect(route('/', '#/product/42')).toBe('/product/42');
    expect(route('/', '#!/product/42')).toBe('/product/42');
    expect(route('/', '#/')).toBe('/');
  });

  it("drops the hash route's own query and anchor", () => {
    expect(route('/', '#/product/42?ref=x')).toBe('/product/42');
    expect(route('/', '#/product/42#reviews')).toBe('/product/42');
  });

  it('uses the hash route alone under a mounted path', () => {
    expect(route('/app/', '#/product/42')).toBe('/product/42');
  });

  it('falls back to the pathname for a plain anchor or no hash', () => {
    expect(route('/products/a', '#reviews')).toBe('/products/a');
    expect(route('/products/a', '')).toBe('/products/a');
    expect(route('/products/a', '#!reviews')).toBe('/products/a');
  });
});

describe('buildPayload', () => {
  it('defaults page_path to the pathname', () => {
    expect(buildPayload(null, '/p/1')).toEqual({
      body: { page_path: '/p/1', data: {} },
      key: '{"page_path":"/p/1"}',
    });
  });

  it('gives different pages different keys with empty data', () => {
    expect(buildPayload(null, '/products/a')?.key).not.toBe(buildPayload(null, '/products/b')?.key);
  });

  it('builds the same key whatever the key order', () => {
    const a = buildPayload({ data: { b: 1, a: 2 } }, '/x');
    const b = buildPayload({ data: { a: 2, b: 1 } }, '/x');
    expect(a?.key).toBe(b?.key);
  });

  it("lets the customer's data.page_path win in the key", () => {
    expect(buildPayload({ data: { page_path: '/mine' } }, '/x')?.key).toBe('{"page_path":"/mine"}');
  });

  it('uses an explicit page_path', () => {
    expect(buildPayload({ page_path: '/explicit' }, '/x')?.body.page_path).toBe('/explicit');
  });

  it('drops undefined and null values instead of refusing the payload', () => {
    expect(buildPayload({ data: { id: undefined, gone: null, ok: 1 } }, '/x')).toEqual({
      body: { page_path: '/x', data: { ok: 1 } },
      key: '{"ok":1,"page_path":"/x"}',
    });
  });

  it('requires a page_path of 1-512 chars starting with /', () => {
    expect(buildPayload({ page_path: '' }, '/x')).toBeNull();
    expect(buildPayload({ page_path: 'relative' }, '/x')).toBeNull();
    expect(buildPayload({ page_path: '/'.repeat(512) }, '/x')).not.toBeNull();
    expect(buildPayload({ page_path: '/'.repeat(513) }, '/x')).toBeNull();
    expect(buildPayload({ data: { page_path: 5 } }, '/x')).toBeNull();
    expect(buildPayload({ data: { page_path: 'nope' } }, '/x')).toBeNull();
  });

  it('refuses data over the per-key limits', () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect(buildPayload({ data: many }, '/x')).toBeNull();
    expect(buildPayload({ data: { ['k'.repeat(65)]: 1 } }, '/x')).toBeNull();
    expect(buildPayload({ data: { v: 'x'.repeat(513) } }, '/x')).toBeNull();
    expect(buildPayload({ data: { v: { nested: true } } }, '/x')).toBeNull();
    expect(buildPayload({ data: { v: Number.NaN } }, '/x')).toBeNull();
  });

  // Shared boundary examples: plan 1 asserts the same three on the server.
  it('accepts a stored payload of exactly 4096 bytes and refuses 4097', () => {
    const exact = buildPayload({ data: dataOfSize(4096) }, '/x');
    expect(exact).not.toBeNull();
    expect(new TextEncoder().encode(exact!.key).length).toBe(4096);
    expect(buildPayload({ data: dataOfSize(4097) }, '/x')).toBeNull();
  });

  it('refuses an empty page_path (shared example)', () => {
    expect(buildPayload({ page_path: '' }, '/x')).toBeNull();
  });

  it('counts UTF-8 bytes, not characters', () => {
    const wide = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`k${i}`, 'é'.repeat(512)]));
    expect(buildPayload({ data: wide }, '/x')).toBeNull();
  });
});
