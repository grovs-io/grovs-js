import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmartBannerController } from '../../src/smartBanner/controller';
import { BannerStore, LIST_TTL_MS } from '../../src/smartBanner/store';
import { HOST_ID } from '../../src/smartBanner/view';
import { ApiService } from '../../src/net/api';
import { resolveConfig } from '../../src/core/config';
import { Context } from '../../src/core/context';
import { Logger } from '../../src/logging/logger';
import { FakeStorage } from '../helpers/fake-storage';
import type { TransportResponse } from '../../src/net/transport';
import { HoldingTransport, RAW_BANNER, deferred } from './fixtures';

const DAY = 86_400_000;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36';
const originalPushState = history.pushState.bind(history);
const originalReplaceState = history.replaceState.bind(history);
// jsdom has no maxTouchPoints; define it so it can be spied on.
if (!('maxTouchPoints' in Navigator.prototype)) {
  Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 0 });
}

const list = (overrides: Record<string, unknown> = {}): TransportResponse => ({
  ok: true,
  status: 200,
  body: { smart_banners: [{ ...RAW_BANNER, ...overrides }] },
});
const LIST = list();
const link = (url: string): TransportResponse => ({ ok: true, status: 200, body: { link: url } });

function setup(ua = IPHONE) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(5);
  const transport = new HoldingTransport();
  const api = new ApiService(resolveConfig({ apiKey: 'k' }), new Context(), transport, () => null);
  const track = vi.fn();
  let generation = 0;
  const controller = new SmartBannerController({
    api,
    logger: new Logger(),
    store: new BannerStore(new FakeStorage(), 'k', () => Date.now()),
    track,
    generation: () => generation,
  });
  return { controller, transport, api, track, bumpGeneration: () => (generation += 1) };
}

function anchor(): HTMLAnchorElement | null {
  return (document.getElementById(HOST_ID)?.shadowRoot?.querySelector('a.button') ?? null) as HTMLAnchorElement | null;
}

function views(track: ReturnType<typeof vi.fn>): unknown[] {
  return track.mock.calls.filter(([name]) => name === 'smart_banner_view');
}

function closeBanner(): void {
  (document.getElementById(HOST_ID)!.shadowRoot!.querySelector('button.close') as HTMLButtonElement).click();
}

async function settle(ms = 32): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function breakSessionStorage(): void {
  for (const method of ['getItem', 'setItem'] as const) {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error('SecurityError');
    });
  }
}

function clockAt(start: number): (ms: number) => void {
  let now = start;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return (ms) => {
    now += ms;
  };
}

describe('SmartBannerController', () => {
  beforeEach(() => {
    sessionStorage.clear();
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    history.replaceState({}, '', '/products/a');
    document.body.innerHTML = '<p>page</p>';
  });
  afterEach(() => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    vi.restoreAllMocks();
  });

  it('shows nothing on desktop and sends nothing', async () => {
    const { controller, transport } = setup(DESKTOP);
    controller.start();
    await controller.settled;
    expect(document.getElementById(HOST_ID)).toBeNull();
    expect(transport.requests).toHaveLength(0);
  });

  it('renders with the default link, then swaps in the page link', async () => {
    const { controller, transport, track } = setup();
    transport.enqueue(LIST);
    const pending = deferred();
    transport.holds.set('/smart_banners/1/link', pending.promise);
    controller.setLinkData({ data: { product: 'a' } });
    controller.start();
    await settle();

    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/default');
    expect(transport.requestsTo('/smart_banners/1/link')[0]?.body).toEqual({
      page_path: '/products/a',
      data: { product: 'a' },
    });
    pending.resolve(link('https://go.example.com/a'));
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/a');
    expect(track).toHaveBeenCalledWith('smart_banner_view', { smart_banner_id: 1 });
    controller.stop();
  });

  it('resets href on setLinkData and ignores the stale response', async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST).enqueue(link('https://go.example.com/a'));
    controller.setLinkData({ data: { product: 'a' } });
    controller.start();
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/a');

    const slow = deferred();
    transport.holds.set('/link', slow.promise);
    controller.setLinkData({ data: { product: 'b' } });
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/default');

    transport.enqueue(link('https://go.example.com/c'));
    controller.setLinkData({ data: { product: 'c' } });
    await settle();
    slow.resolve(link('https://go.example.com/b'));
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/c');
    controller.stop();
  });

  it('on a pathname change resets href synchronously, clears data, and refetches once data is set', async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST).enqueue(link('https://go.example.com/a'));
    controller.start();
    await settle();
    controller.setLinkData({ data: { product: 'a' } });
    await settle();

    const slow = deferred();
    transport.holds.set('/link', slow.promise);
    const before = transport.requestsTo('/link').length;
    history.pushState({}, '', '/products/b');
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/default');
    await settle();
    expect(transport.requestsTo('/link')).toHaveLength(before);
    controller.setLinkData({ data: { product: 'b' } });
    await settle();
    const last = transport.requestsTo('/smart_banners/1/link').at(-1);
    expect(last?.body).toEqual({ page_path: '/products/b', data: { product: 'b' } });
    slow.resolve(link('https://go.example.com/b'));
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/b');
    controller.stop();
  });

  it('redraws the banner and restores the CSS vars after a Turbo/pjax body swap removes the host', async () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ height: 60, bottom: 60, top: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) });
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    const first = document.getElementById(HOST_ID);
    expect(first).not.toBeNull();
    expect(document.documentElement.style.getPropertyValue('--grovs-smart-banner-top')).toBe('60px');

    // Turbo/Hotwire/pjax replaces document.body wholesale on navigation,
    // taking the host with it without going through the controller's removeView().
    document.body.innerHTML = '<p>new page</p>';
    expect(document.getElementById(HOST_ID)).toBeNull();

    history.pushState({}, '', '/products/b');
    await settle();

    const redrawn = document.getElementById(HOST_ID);
    expect(redrawn).not.toBeNull();
    expect(redrawn).not.toBe(first);
    expect(document.documentElement.style.getPropertyValue('--grovs-smart-banner-top')).toBe('60px');
    controller.stop();
    rectSpy.mockRestore();
  });

  it('keeps link data when only the query or hash changes', async () => {
    const { controller, transport, track } = setup();
    transport.enqueue(LIST).enqueue(link('https://go.example.com/a'));
    controller.start();
    await settle();
    controller.setLinkData({ data: { product: 'a' } });
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/a');
    const before = transport.requestsTo('/link').length;

    history.replaceState({}, '', '/products/a?color=red');
    history.replaceState({}, '', '/products/a#reviews');
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/a');
    expect(transport.requestsTo('/link')).toHaveLength(before);
    expect(views(track)).toHaveLength(1);
    controller.stop();
  });

  describe('hash-routed pages', () => {
    it('matches URL patterns against the hash route', async () => {
      history.replaceState({}, '', '/#/product/42');
      const { controller, transport } = setup();
      transport.enqueue(list({ url_include: ['/product/*'] }));
      controller.start();
      await settle();
      expect(document.getElementById(HOST_ID)).not.toBeNull();
      controller.stop();
    });

    it('treats a hash route change as a new page and sends the hash route as page_path', async () => {
      history.replaceState({}, '', '/#/product/1');
      const { controller, transport, track } = setup();
      transport.enqueue(LIST).enqueue(link('https://go.example.com/1'));
      controller.start();
      await settle();
      controller.setLinkData({ data: { product: '1' } });
      await settle();
      expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/1');

      location.hash = '#/product/2';
      await settle();
      expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/default');
      expect(views(track)).toHaveLength(2);
      transport.enqueue(link('https://go.example.com/2'));
      controller.setLinkData({ data: { product: '2' } });
      await settle();
      expect(transport.requestsTo('/link').map((r) => r.body)).toEqual([
        { page_path: '/product/1', data: { product: '1' } },
        { page_path: '/product/2', data: { product: '2' } },
      ]);
      expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/2');
      controller.stop();
    });

    it('does not treat a plain anchor after a hash route as a new page', async () => {
      history.replaceState({}, '', '/#/product/1');
      const { controller, transport, track } = setup();
      transport.enqueue(LIST).enqueue(link('https://go.example.com/1'));
      controller.start();
      await settle();
      controller.setLinkData({ data: { product: '1' } });
      await settle();

      location.hash = '#/product/1#reviews';
      await settle();
      expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/1');
      expect(transport.requestsTo('/link')).toHaveLength(1);
      expect(views(track)).toHaveLength(1);
      controller.stop();
    });

    it('holds hide() for the hash route only', async () => {
      history.replaceState({}, '', '/#/product/1');
      const { controller, transport } = setup();
      transport.enqueue(LIST);
      controller.start();
      await settle();
      controller.hide();
      await controller.refresh();
      expect(document.getElementById(HOST_ID)).toBeNull();
      location.hash = '#/product/2';
      await settle();
      expect(document.getElementById(HOST_ID)).not.toBeNull();
      controller.stop();
    });
  });

  it('keeps setLinkData made after navigation and sends it once', async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();

    const slow = deferred();
    transport.holds.set('/smart_banners/1/link', slow.promise);
    history.pushState({}, '', '/products/b');
    controller.setLinkData({ data: { product: 'b' } });
    await settle();
    const forB = transport
      .requestsTo('/smart_banners/1/link')
      .filter((r) => (r.body as { data: { product?: string } }).data.product === 'b');
    expect(forB).toHaveLength(1);
    expect(forB[0]?.body).toEqual({ page_path: '/products/b', data: { product: 'b' } });
    slow.resolve(link('https://go.example.com/b'));
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/b');
    controller.stop();
  });

  it('after a failed link keeps the default link and sends no link request for 60 s', async () => {
    // Retry policy lives in FetchTransport (its own tests); FakeTransport stands in for it here.
    const advance = clockAt(1_000_000);
    const { controller, transport } = setup();
    transport.enqueue(LIST).enqueueStatus(503);
    controller.setLinkData({ data: { product: 'x' } });
    controller.start();
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/default');
    expect(transport.requestsTo('/smart_banners/1/link')).toHaveLength(1);

    advance(59_000);
    controller.setLinkData({ data: { product: 'y' } });
    await settle();
    expect(transport.requestsTo('/smart_banners/1/link')).toHaveLength(1);

    advance(1_000);
    transport.enqueue(link('https://go.example.com/y'));
    controller.setLinkData({ data: { product: 'y' } });
    await settle();
    expect(transport.requestsTo('/smart_banners/1/link')).toHaveLength(2);
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/y');
    expect(Object.entries(sessionStorage).some(([k, v]) => k.endsWith(':fail') && v !== '0')).toBe(false);
    controller.stop();
  });

  it('a /link 429 with Retry-After: 60 is not cached, backs off, and keeps the default link meanwhile', async () => {
    const advance = clockAt(1_000_000);
    const { controller, transport } = setup();
    transport.enqueue(LIST).enqueue({ ok: false, status: 429, body: {}, retryAfterMs: 60_000 });
    controller.setLinkData({ data: { product: 'x' } });
    controller.start();
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/default');
    expect(transport.requestsTo('/smart_banners/1/link')).toHaveLength(1);

    advance(59_999);
    controller.setLinkData({ data: { product: 'x' } });
    await settle();
    // Not served from cache: still backing off, so no second request yet.
    expect(transport.requestsTo('/smart_banners/1/link')).toHaveLength(1);
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/default');

    advance(1);
    transport.enqueue(link('https://go.example.com/x'));
    controller.setLinkData({ data: { product: 'x' } });
    await settle();
    // The backoff clearing produced a real second request — proof the 429 was
    // never cached as the page link (a cache hit would have skipped it).
    expect(transport.requestsTo('/smart_banners/1/link')).toHaveLength(2);
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/x');
    controller.stop();
  });

  it('backs off after a 0, 429 or 5xx, but not after a 4xx', async () => {
    for (const [status, backsOff] of [[422, false], [404, false], [0, true], [429, true], [500, true]] as const) {
      sessionStorage.clear();
      const { controller, transport } = setup();
      transport.enqueue(LIST).enqueueStatus(status);
      controller.setLinkData({ data: { product: 'x' } });
      controller.start();
      await settle();
      transport.enqueue(link('https://go.example.com/y'));
      controller.setLinkData({ data: { product: 'y' } });
      await settle();
      expect(transport.requestsTo('/link'), `link after ${status}`).toHaveLength(backsOff ? 1 : 2);
      controller.stop();

      sessionStorage.clear();
      const list = setup();
      list.transport.enqueueStatus(status);
      list.controller.start();
      await settle();
      expect(sessionStorage.getItem('grovs_sb:k:fail') !== null, `list after ${status}`).toBe(backsOff);
      list.controller.stop();
    }
  });

  it('caches the default link after a 4xx link, and an empty list for the list TTL after a 4xx list', async () => {
    const advance = clockAt(1_000_000);
    const { controller, transport } = setup();
    transport.enqueue(LIST).enqueueStatus(422);
    controller.setLinkData({ data: { product: 'x' } });
    controller.start();
    await settle();
    await controller.refresh();
    controller.setLinkData({ data: { product: 'x' } });
    await settle();
    expect(transport.requestsTo('/link')).toHaveLength(1);
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/default');
    controller.stop();

    sessionStorage.clear();
    const list = setup();
    list.transport.enqueueStatus(404).enqueue(LIST);
    list.controller.start();
    await settle();
    advance(LIST_TTL_MS);
    await list.controller.refresh();
    expect(list.transport.requestsTo('/smart_banners')).toHaveLength(1);
    expect(document.getElementById(HOST_ID)).toBeNull();
    advance(1);
    await list.controller.refresh();
    expect(list.transport.requestsTo('/smart_banners')).toHaveLength(2);
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    list.controller.stop();
  });

  it('honours a Retry-After over 60 s, across page loads, even after an unrelated success', async () => {
    const advance = clockAt(1_000_000);
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    const x = deferred();
    const y = deferred();
    transport.holds.set('/link', x.promise);
    controller.setLinkData({ data: { product: 'x' } });
    controller.start();
    await settle();
    transport.holds.set('/link', y.promise);
    controller.setLinkData({ data: { product: 'y' } });
    await settle();
    x.resolve({ ok: false, status: 429, body: {}, retryAfterMs: 120_000 });
    await settle();
    y.resolve(link('https://go.example.com/y'));
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/y');

    advance(119_999);
    controller.setLinkData({ data: { product: 'z' } });
    await settle();
    expect(transport.requestsTo('/link')).toHaveLength(2);
    controller.stop();
    const next = setup();
    next.controller.start();
    await settle();
    expect(next.transport.requests).toHaveLength(0);

    advance(1);
    next.transport.enqueue(link('https://go.example.com/z'));
    next.controller.setLinkData({ data: { product: 'z' } });
    await settle();
    expect(next.transport.requestsTo('/link')).toHaveLength(1);
    next.controller.stop();
  });

  it('clamps a server-directed backoff to one hour', async () => {
    const advance = clockAt(1_000_000);
    const { controller, transport } = setup();
    transport.enqueue({ ok: false, status: 503, body: {}, retryAfterMs: 86_400_000 });
    controller.start();
    await settle();
    advance(3_599_999);
    await controller.refresh();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(1);
    sessionStorage.clear();
    advance(1);
    transport.enqueue(LIST);
    await controller.refresh();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(2);
    controller.stop();
  });

  it('keeps the 50 most recent links in memory when sessionStorage throws', async () => {
    breakSessionStorage();
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    for (let i = 0; i <= 50; i += 1) transport.enqueue(link(`https://go.example.com/${i}`));
    controller.start();
    await settle();
    for (let i = 0; i <= 50; i += 1) {
      controller.setLinkData({ data: { product: String(i) } });
      await settle(1);
    }
    expect(transport.requestsTo('/link')).toHaveLength(51);
    transport.enqueue(link('https://go.example.com/0'));
    controller.setLinkData({ data: { product: '1' } });
    await settle(1);
    expect(transport.requestsTo('/link')).toHaveLength(51);
    controller.setLinkData({ data: { product: '0' } });
    await settle(1);
    expect(transport.requestsTo('/link')).toHaveLength(52);
    controller.stop();
  });

  it('keeps a banner that is showing when the list refresh fails temporarily', async () => {
    const advance = clockAt(1_000_000);
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    advance(LIST_TTL_MS + 1);
    transport.enqueueStatus(503);
    await controller.refresh();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(2);
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    history.pushState({}, '', '/products/b');
    await settle();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(2);
    expect(document.getElementById(HOST_ID)).not.toBeNull();

    advance(60_000);
    transport.enqueue({ ok: true, status: 200, body: { smart_banners: [] } });
    await controller.refresh();
    expect(document.getElementById(HOST_ID)).toBeNull();
    controller.stop();
  });

  it('keeps link data and hide() set for the new route before its navigation event (hash)', async () => {
    history.replaceState({}, '', '/#/product/1');
    const { controller, transport } = setup();
    transport.enqueue(LIST).enqueue(link('https://go.example.com/2'));
    controller.start();
    await settle();
    location.hash = '#/product/2';
    controller.setLinkData({ data: { product: '2' } });
    await settle();
    expect(transport.requestsTo('/link').map((r) => r.body)).toEqual([
      { page_path: '/product/2', data: { product: '2' } },
    ]);
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/2');

    location.hash = '#/product/3';
    controller.hide();
    await settle();
    expect(document.getElementById(HOST_ID)).toBeNull();
    controller.stop();
  });

  it('keeps link data set for the new route before its navigation event (history Back)', async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST).enqueue(link('https://go.example.com/b'));
    // The app's router hears popstate first and sets the page's data.
    const onPop = (): void => controller.setLinkData({ data: { product: 'b' } });
    window.addEventListener('popstate', onPop);
    controller.start();
    await settle();
    history.pushState({}, '', '/products/b');
    history.pushState({}, '', '/products/c');
    await settle();
    history.back();
    await settle();
    window.removeEventListener('popstate', onPop);
    expect(location.pathname).toBe('/products/b');
    expect(transport.requestsTo('/link').map((r) => r.body)).toEqual([
      { page_path: '/products/b', data: { product: 'b' } },
    ]);
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/b');
    controller.stop();
  });

  it('keeps the failure backoff across page loads', async () => {
    const advance = clockAt(1_000_000);
    const first = setup();
    first.transport.enqueueStatus(500);
    first.controller.start();
    await settle();
    first.controller.stop();

    const second = setup();
    second.controller.setLinkData({ data: { product: 'a' } });
    second.controller.start();
    await settle();
    expect(second.transport.requests).toHaveLength(0);

    advance(60_000);
    second.transport.enqueue(LIST).enqueue(link('https://go.example.com/a'));
    await second.controller.refresh();
    expect(second.transport.requestsTo('/smart_banners')).toHaveLength(1);
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/a');
    second.controller.stop();
  });

  it('does not send data that breaks the limits', async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    const before = transport.requestsTo('/link').length;
    controller.setLinkData({ data: { v: 'x'.repeat(600) } });
    await settle();
    expect(transport.requestsTo('/link')).toHaveLength(before);
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/default');
    controller.stop();
  });

  it('uses the session cache for the list and per-path links', async () => {
    const first = setup();
    first.transport.enqueue(LIST).enqueue(link('https://go.example.com/a'));
    first.controller.setLinkData({ data: { product: 'a' } });
    first.controller.start();
    await settle();
    first.controller.stop();

    const second = setup();
    second.controller.setLinkData({ data: { product: 'a' } });
    second.controller.start();
    await settle();
    expect(second.transport.requests).toHaveLength(0);
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/a');
    second.controller.stop();
  });

  it('redraws when the same banner comes back with a new config, counting one view', async () => {
    const { controller, transport, track } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();

    controller.clearCaches();
    transport.enqueue(list({ title: 'New title', position: 'bottom' }));
    await controller.refresh();
    const root = document.getElementById(HOST_ID)!.shadowRoot!;
    expect(root.querySelector('.title')?.textContent).toBe('New title');
    expect(root.querySelector('.bar.bottom')).not.toBeNull();
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
    expect(views(track)).toHaveLength(1);
    controller.stop();
  });

  it('does not draw a second banner when another SDK copy already did', async () => {
    document.body.innerHTML = `<div id="${HOST_ID}"></div><p>page</p>`;
    const { controller, transport, track } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
    expect(views(track)).toHaveLength(0);
    expect(transport.requestsTo('/link')).toHaveLength(0);
    controller.stop();
  });

  it('dismisses on close, tracks it, and stays dismissed across navigation', async () => {
    const { controller, transport, track } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    closeBanner();
    expect(document.getElementById(HOST_ID)).toBeNull();
    expect(track).toHaveBeenCalledWith('smart_banner_dismiss', { smart_banner_id: 1 });
    history.pushState({}, '', '/products/c');
    await settle();
    expect(document.getElementById(HOST_ID)).toBeNull();
    controller.stop();
  });

  it('with dismiss_days 0 hides it for this page view only', async () => {
    const { controller, transport } = setup();
    transport.enqueue(list({ dismiss_days: 0 }));
    controller.start();
    await settle();
    closeBanner();
    await controller.refresh();
    expect(document.getElementById(HOST_ID)).toBeNull();
    history.pushState({}, '', '/products/z');
    await settle();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    controller.stop();
  });

  it('tracks a click', async () => {
    const { controller, transport, track } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    const a = anchor()!;
    a.addEventListener('click', (e) => e.preventDefault());
    a.click();
    expect(track).toHaveBeenCalledWith('smart_banner_click', { smart_banner_id: 1 });
    controller.stop();
  });

  it('does not prevent the anchor default navigation on click', async () => {
    const { controller, transport, track } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    const a = anchor()!;
    let preventedBySdk: boolean | null = null;
    // Registered after the SDK's own listener: by the time this runs, the SDK already had its turn.
    a.addEventListener('click', (e) => {
      preventedBySdk = e.defaultPrevented;
      e.preventDefault(); // jsdom has no navigation; stop it here instead of letting it log.
    });
    a.click();
    expect(preventedBySdk).toBe(false);
    expect(track).toHaveBeenCalledWith('smart_banner_click', { smart_banner_id: 1 });
    controller.stop();
  });

  it('tapping Open removes the banner right after the navigation starts', async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    const a = anchor()!;
    let preventedBySdk: boolean | null = null;
    a.addEventListener('click', (e) => {
      preventedBySdk = e.defaultPrevented;
      e.preventDefault();
    });
    a.click();
    expect(preventedBySdk).toBe(false);
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    await settle();
    expect(document.getElementById(HOST_ID)).toBeNull();
    controller.stop();
  });

  it('a click hides the banner for open_hide_days, then it reappears once that expires', async () => {
    const advance = clockAt(1_000_000);
    const { controller, transport } = setup();
    // The 10-minute list cache expires well before a 10-day wait, so each navigation below re-fetches it.
    transport
      .enqueue(list({ open_hide_days: 10 }))
      .enqueue(list({ open_hide_days: 10 }))
      .enqueue(list({ open_hide_days: 10 }));
    controller.start();
    await settle();
    const a = anchor()!;
    a.addEventListener('click', (e) => e.preventDefault());
    a.click();

    advance(10 * DAY - 1);
    history.pushState({}, '', '/products/f');
    await settle();
    expect(document.getElementById(HOST_ID)).toBeNull();

    advance(1);
    history.pushState({}, '', '/products/g');
    await settle();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    controller.stop();
  });

  it('with open_hide_days 0 a click hides it for this page view only', async () => {
    const { controller, transport } = setup();
    transport.enqueue(list({ open_hide_days: 0 }));
    controller.start();
    await settle();
    const a = anchor()!;
    a.addEventListener('click', (e) => e.preventDefault());
    a.click();
    await controller.refresh();
    expect(document.getElementById(HOST_ID)).toBeNull();
    history.pushState({}, '', '/products/h');
    await settle();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    controller.stop();
  });

  it('hide() lasts until the next navigation and is not a dismissal', async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    controller.hide();
    expect(document.getElementById(HOST_ID)).toBeNull();
    await controller.refresh();
    expect(document.getElementById(HOST_ID)).toBeNull();
    history.pushState({}, '', '/products/d');
    await settle();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    controller.stop();
  });

  it('clearCaches() forgets hide() on the same page', async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    controller.hide();
    controller.clearCaches();
    transport.enqueue(LIST);
    await controller.refresh();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    controller.stop();
  });

  it('hide() survives stop/start on the same page (re-configure, auth retry, consent)', async () => {
    const { controller, transport, bumpGeneration } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    controller.hide();
    bumpGeneration();
    controller.stop();
    controller.start();
    await settle();
    expect(document.getElementById(HOST_ID)).toBeNull();
    history.pushState({}, '', '/products/d');
    await settle();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    controller.stop();
  });

  it('removes the banner on stop and ignores responses from before', async () => {
    const { controller, transport, bumpGeneration } = setup();
    transport.enqueue(LIST);
    const slow = deferred();
    transport.holds.set('/link', slow.promise);
    controller.setLinkData({ data: { product: 'a' } });
    controller.start();
    await settle();
    bumpGeneration();
    controller.stop();
    slow.resolve(link('https://go.example.com/late'));
    await settle();
    expect(document.getElementById(HOST_ID)).toBeNull();
    expect(Object.keys(sessionStorage).some((k) => k.includes(':link:'))).toBe(false);
  });

  it('caches nothing from a list response that arrives after stop', async () => {
    const { controller, transport, bumpGeneration } = setup();
    const held = deferred();
    transport.holds.set('/smart_banners', held.promise);
    controller.start();
    await settle();
    bumpGeneration();
    controller.stop();
    held.resolve(LIST);
    await settle();
    expect(Object.keys(sessionStorage).some((k) => k.startsWith('grovs_sb:'))).toBe(false);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it('re-evaluates when started again while running (setEnabled(true) racing configure)', async () => {
    const { controller, transport, bumpGeneration } = setup();
    const held = deferred();
    transport.holds.set('/smart_banners', held.promise);
    transport.enqueue(LIST);
    controller.start();
    await settle();
    bumpGeneration();
    controller.start();
    await settle();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    held.resolve(LIST);
    await settle();
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
    controller.stop();
  });

  it('never throws or rejects when the API throws', async () => {
    const { controller, api } = setup();
    vi.spyOn(api, 'smartBanners').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => controller.start()).not.toThrow();
    await expect(controller.settled).resolves.toBeUndefined();
    await expect(controller.refresh()).resolves.toBeUndefined();
    controller.stop();
  });

  it('keeps the default link and never rejects when the link request rejects', async () => {
    const { controller, transport, api } = setup();
    transport.enqueue(LIST);
    vi.spyOn(api, 'smartBannerLink').mockRejectedValue(new Error('offline'));
    controller.setLinkData({ data: { product: 'a' } });
    controller.start();
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/default');
    await expect(controller.refresh()).resolves.toBeUndefined();
    expect(() => controller.setLinkData({ data: { product: 'x' } })).not.toThrow();
    await settle();
    controller.stop();
  });

  it('tracks one view per page', async () => {
    const { controller, transport, track } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    await controller.refresh();
    expect(views(track)).toHaveLength(1);
    history.pushState({}, '', '/products/e');
    await settle();
    expect(views(track)).toHaveLength(2);
    controller.stop();
  });
  it('shares one list request between evaluations while it is in flight', async () => {
    const { controller, transport } = setup();
    const held = deferred();
    transport.holds.set('/smart_banners', held.promise);
    controller.start();
    void controller.refresh();
    await settle();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(1);
    held.resolve(LIST);
    await settle();
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
    controller.stop();
  });

  it('keeps the list and links in memory when sessionStorage throws', async () => {
    breakSessionStorage();
    const { controller, transport } = setup();
    transport.enqueue(LIST).enqueue(link('https://go.example.com/a')).enqueue(link('https://go.example.com/b'));
    controller.setLinkData({ data: {} });
    controller.start();
    await settle();
    history.pushState({}, '', '/products/b');
    controller.setLinkData({ data: {} });
    await settle();
    history.pushState({}, '', '/products/a');
    controller.setLinkData({ data: {} });
    await settle();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(1);
    expect(transport.requestsTo('/link')).toHaveLength(2);
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/a');

    controller.stop();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(2);
    controller.clearCaches();
    transport.enqueue(LIST);
    await controller.refresh();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(3);
    controller.stop();
  });

  it('after a failed list asks again only after 60 s or clearCaches(), even across stop()', async () => {
    const advance = clockAt(1_000_000);
    const { controller, transport } = setup();
    transport.enqueueStatus(500);
    controller.start();
    await settle();
    history.pushState({}, '', '/products/b');
    await settle();
    advance(59_000);
    await controller.refresh();
    controller.stop();
    controller.start();
    await settle();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(1);
    expect(document.getElementById(HOST_ID)).toBeNull();

    advance(2_000);
    transport.enqueueStatus(500);
    await controller.refresh();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(2);

    controller.clearCaches();
    transport.enqueue(LIST);
    await controller.refresh();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(3);
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    controller.stop();
  });

  it('without link data never asks for a page link and keeps the default link', async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    await controller.refresh();
    history.pushState({}, '', '/products/b');
    await settle();
    expect(transport.requestsTo('/link')).toHaveLength(0);
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/default');
    controller.stop();
  });

  it('with link data asks once, immediately', async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST).enqueue(link('https://go.example.com/a'));
    controller.setLinkData({ data: { product: 'a' } });
    controller.start();
    await settle(5);
    await controller.refresh();
    expect(transport.requestsTo('/link').map((r) => r.body)).toEqual([
      { page_path: '/products/a', data: { product: 'a' } },
    ]);
    controller.stop();
  });

  it('sends exactly one link request when an SPA page sets link data late', async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    controller.start();
    await settle();
    history.pushState({}, '', '/products/b');
    await settle(100);
    expect(transport.requestsTo('/link')).toHaveLength(0);
    transport.enqueue(link('https://go.example.com/b'));
    controller.setLinkData({ data: { product: 'b' } });
    await settle();
    await controller.refresh();
    expect(transport.requestsTo('/link').map((r) => r.body)).toEqual([
      { page_path: '/products/b', data: { product: 'b' } },
    ]);
    controller.stop();
  });

  it("does not apply page A's link when it arrives after navigating to B", async () => {
    const { controller, transport } = setup();
    transport.enqueue(LIST);
    const slowA = deferred();
    transport.holds.set('/link', slowA.promise);
    controller.setLinkData({ data: { product: 'a' } });
    controller.start();
    await settle();
    transport.enqueue(link('https://go.example.com/b'));
    history.pushState({}, '', '/products/b');
    controller.setLinkData({ data: { product: 'b' } });
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/b');
    slowA.resolve(link('https://go.example.com/a'));
    await settle();
    expect(anchor()?.getAttribute('href')).toBe('https://go.example.com/b');
    controller.stop();
  });

  it('drops link data set before start on another page', async () => {
    const { controller, transport } = setup();
    controller.setLinkData({ data: { product: 'a' } });
    history.replaceState({}, '', '/products/b');
    transport.enqueue(LIST);
    controller.start();
    await settle();
    expect(transport.requestsTo('/link')).toHaveLength(0);
    controller.stop();
  });

  it('keeps link data set before start on the same page', async () => {
    const { controller, transport } = setup();
    controller.setLinkData({ data: { product: 'a' } });
    transport.enqueue(LIST);
    controller.start();
    await settle();
    expect(transport.requestsTo('/link').map((r) => r.body)).toEqual([
      { page_path: '/products/a', data: { product: 'a' } },
    ]);
    controller.stop();
  });
});
