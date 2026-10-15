import { beforeEach, describe, expect, it, vi } from 'vitest';
import Grovs from '../src/index';
import { GrovsClient } from '../src/core/client';
import { EventsHandler } from '../src/events/events-handler';
import { __resetCoexistenceState } from '../src/compat/v1';
import { FakeTransport } from './helpers/fake-transport';
import { FakeStorage } from './helpers/fake-storage';
import { HOST_ID } from '../src/smartBanner/view';
import { RAW_BANNER } from './smartBanner/fixtures';

describe('public facade', () => {
  // The facade keeps an authenticated client across a same-settings configure(); each test starts unauthenticated.
  beforeEach(() => Grovs.reset());

  it('exposes the v2 surface', () => {
    expect(typeof Grovs.configure).toBe('function');
    expect(typeof Grovs.generateLink).toBe('function');
    expect(typeof Grovs.setUserIdentifier).toBe('function');
    expect(typeof Grovs.setUserAttributes).toBe('function');
    expect(typeof Grovs.isAuthenticated).toBe('function');
    expect(typeof Grovs.setEnabled).toBe('function');
    expect(typeof Grovs.setDebugLevel).toBe('function');
    expect(typeof Grovs.showMessagesList).toBe('function');
    expect(typeof Grovs.getMessages).toBe('function');
    expect(typeof Grovs.numberOfUnreadMessages).toBe('function');
    expect(typeof Grovs.markMessageAsRead).toBe('function');
    expect(typeof Grovs.displayAutomaticMessages).toBe('function');
    expect(typeof Grovs.allReceivedPayloadsSinceStartup).toBe('function');
    expect(typeof Grovs.lastReceivedPayload).toBe('function');
    expect(typeof Grovs.smartBanner.setLinkData).toBe('function');
    expect(typeof Grovs.smartBanner.hide).toBe('function');
    expect(typeof Grovs.smartBanner.refresh).toBe('function');
  });

  it('exposes the v1 class for existing integrators', () => {
    expect(typeof Grovs.V1).toBe('function');
  });

  // v1 integrators construct the SDK — `new Grovs(key, testEnv, cb)` from
  // npm, `new Grovs.default(...)` from the CDN bundle — and MIGRATION.md
  // promises that code keeps working without edits.
  it('is constructable as the v1 class', () => {
    const instance = new Grovs('k', false, () => undefined, {
      transport: new FakeTransport(),
      storage: new FakeStorage(),
    });
    expect(instance).toBeInstanceOf(Grovs.V1);
    expect(typeof instance.start).toBe('function');
  });

  it('reports not-authenticated before configure', () => {
    expect(Grovs.isAuthenticated()).toBe(false);
  });

  it('returns null from generateLink before configure rather than throwing', async () => {
    await expect(Grovs.generateLink({ title: 'T' })).resolves.toBeNull();
  });

  it('returns empty collections before configure rather than throwing', async () => {
    expect(Grovs.allReceivedPayloadsSinceStartup()).toEqual([]);
    expect(Grovs.lastReceivedPayload()).toBeNull();
    expect(Grovs.userIdentifier).toBeNull();
    expect(Grovs.userAttributes).toBeNull();
    await expect(Grovs.getMessages(1)).resolves.toEqual([]);
    await expect(Grovs.numberOfUnreadMessages()).resolves.toBe(0);
    await expect(Grovs.markMessageAsRead(1)).resolves.toBe(true);
    await expect(Grovs.showMessagesList()).resolves.toBeUndefined();
  });

  // The per-client pipeline guard cannot help here: a second configure()
  // builds a *new* client, so without this the previous one's flush interval,
  // lifecycle listeners and History patch stay live and everything is tracked
  // twice. React strict mode and hot reload both hit this path.
  it('retires the previous client when configure() is called twice', async () => {
    const shutdown = vi.spyOn(GrovsClient.prototype, 'shutdown');

    await Grovs.configure({ apiKey: 'k' });
    expect(shutdown).not.toHaveBeenCalled();

    // Different settings: an identical repeat keeps the client instead.
    await Grovs.configure({ apiKey: 'k', debugLevel: 'error' });
    expect(shutdown).toHaveBeenCalledTimes(1);

    shutdown.mockRestore();
  });

  it('keeps the working client when a later configure() throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ linksquared: 'v-1' }), { status: 200 })),
    );
    await Grovs.configure({ apiKey: 'k' });
    expect(Grovs.isAuthenticated()).toBe(true);

    const dispose = vi.spyOn(GrovsClient.prototype, 'dispose');
    await expect(Grovs.configure({ apiKey: '   ' })).rejects.toThrow(/API key is required/);

    expect(dispose).not.toHaveBeenCalled();
    // The facade still routes to the live client, not a retired one.
    expect(Grovs.isAuthenticated()).toBe(true);
    await expect(Grovs.getMessages(1)).resolves.toEqual([]);
  });

  // Pre-existing invariant, not new to this diff: the replacement's queue loads
  // from storage, so the outgoing client must persist before it is constructed.
  // The pagehide is load-bearing — it forces the replacement's own write, which
  // is what overwrites a stale snapshot.
  it('keeps events tracked before a reconfigure', async () => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ linksquared: 'v-1' }), { status: 200 })),
    );

    await Grovs.configure({ apiKey: 'k' });
    Grovs.track('from_client_a');
    // Different settings, so the client is rebuilt rather than kept.
    await Grovs.configure({ apiKey: 'k', debugLevel: 'error' });

    // An unload is pagehide then the hide; the request leaves from the hide.
    window.dispatchEvent(new Event('pagehide'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    // The replacement's exit flush carries the first client's event: it
    // loaded it from the snapshot the outgoing client wrote.
    const bodies = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String((call[1] as RequestInit | undefined)?.body ?? ''),
    );
    expect(bodies.some((body) => body.includes('from_client_a'))).toBe(true);
  });

  // Spec T9. React strict mode and hot reload both configure twice; the
  // replacement's handler is new, so only shared dedup state can catch it.
  it('emits one screen view across a double configure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ linksquared: 'v-1' }), { status: 200 })),
    );
    const enqueue = vi.spyOn(EventsHandler.prototype, 'enqueue');

    document.title = 'Checkout';
    await Grovs.configure({ apiKey: 'k' });
    // Different settings, so the second call builds a new client and handler.
    await Grovs.configure({ apiKey: 'k', debugLevel: 'error' });

    const views = enqueue.mock.calls.filter(([event]) => event.eventName === 'screen_view');
    expect(views).toHaveLength(1);
  });

  it('a repeat configure() with the same settings keeps the shown banner and counts no second view', async () => {
    sessionStorage.clear();
    document.body.innerHTML = '';
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148');
    const fetchMock = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).includes('/smart_banners') ? { smart_banners: [RAW_BANNER] } : { linksquared: 'v-1', has_smart_banners: true },
        ),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const enqueue = vi.spyOn(EventsHandler.prototype, 'enqueue');
    const onDeeplink = vi.fn();
    const config = { apiKey: 'k', onDeeplink };

    await Grovs.configure(config);
    await new Promise((resolve) => setTimeout(resolve, 32));
    const host = document.getElementById(HOST_ID);
    expect(host).not.toBeNull();
    const calls = fetchMock.mock.calls.length;

    await expect(Grovs.configure({ ...config, onDeeplink: vi.fn() })).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 32));
    expect(document.getElementById(HOST_ID)).toBe(host);
    expect(fetchMock.mock.calls.length).toBe(calls);
    const views = enqueue.mock.calls.filter(([event]) => event.eventName === 'smart_banner_view');
    expect(views).toHaveLength(1);

    await Grovs.configure({ ...config, debugLevel: 'warn' });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it('a config that cannot be serialised still configures, and a repeat rebuilds the client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ linksquared: 'v-1' }), { status: 200 })));
    const dispose = vi.spyOn(GrovsClient.prototype, 'dispose');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const config = { apiKey: 'k-cyclic', extra: cyclic } as unknown as Parameters<typeof Grovs.configure>[0];

    await expect(Grovs.configure(config)).resolves.toBe(true);
    dispose.mockClear();
    await expect(Grovs.configure(config)).resolves.toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('a repeat configure() after setEnabled(false) builds an enabled client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ linksquared: 'v-1' }), { status: 200 })),
    );
    const shutdown = vi.spyOn(GrovsClient.prototype, 'shutdown');
    const config = { apiKey: 'k-enabled' };
    await Grovs.configure(config);
    Grovs.setEnabled(false);
    shutdown.mockClear();

    await expect(Grovs.configure(config)).resolves.toBe(true);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(Grovs.isAuthenticated()).toBe(true);
    const enqueue = vi.spyOn(EventsHandler.prototype, 'enqueue');
    Grovs.track('after_reenable');
    expect(enqueue.mock.calls.some(([event]) => event.eventName === 'after_reenable')).toBe(true);
  });

  // Two Grovs clients on one page is unsupported: it
  // double-counts auth, launch events, timers and sessions. Now that the v1
  // constructor and the v2 statics sit on the same export, mixing the two
  // eras is easy to do by accident — so it warns, once.
  describe('dual-entry warning', () => {
    beforeEach(() => __resetCoexistenceState());

    it('warns when the v1 constructor is used after configure()', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await Grovs.configure({ apiKey: 'k' });
      new Grovs('k', false, () => undefined, {
        transport: new FakeTransport(),
        storage: new FakeStorage(),
      });

      expect(spy.mock.calls.some(([msg]) => String(msg).includes('one page'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('warns when configure() runs after a v1 constructor, once only', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      new Grovs('k', false, () => undefined, {
        transport: new FakeTransport(),
        storage: new FakeStorage(),
      });
      await Grovs.configure({ apiKey: 'k' });
      await Grovs.configure({ apiKey: 'k' });

      const hits = spy.mock.calls.filter(([msg]) => String(msg).includes('one page'));
      expect(hits).toHaveLength(1);
      vi.restoreAllMocks();
    });

    it('stays silent when only one entry style is used', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await Grovs.configure({ apiKey: 'k' });
      await Grovs.configure({ apiKey: 'k' });

      expect(spy.mock.calls.some(([msg]) => String(msg).includes('one page'))).toBe(false);
      vi.restoreAllMocks();
    });
  });

  describe('removed messages inbox', () => {
    const INBOX_PATHS =
      /notifications_for_device|number_of_unread_notifications|mark_notification_as_read|notifications_to_display_automatically/;

    function stubFetch() {
      const mock = vi.fn(
        async () => new Response(JSON.stringify({ linksquared: 'v-1' }), { status: 200 }),
      );
      vi.stubGlobal('fetch', mock);
      return mock;
    }

    function urls(mock: ReturnType<typeof stubFetch>): string[] {
      return (mock.mock.calls as unknown[][]).map(([url]) =>
        String(url instanceof Request ? url.url : url),
      );
    }

    it('returns the empty values without a request', async () => {
      document.body.innerHTML = '';
      const fetchMock = stubFetch();
      await Grovs.configure({ apiKey: 'k' });
      expect(Grovs.isAuthenticated()).toBe(true);
      await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
      fetchMock.mockClear();

      await expect(Grovs.showMessagesList()).resolves.toBeUndefined();
      await expect(Grovs.displayAutomaticMessages()).resolves.toBeUndefined();
      await expect(Grovs.getMessages(1)).resolves.toEqual([]);
      await expect(Grovs.numberOfUnreadMessages()).resolves.toBe(0);
      await expect(Grovs.markMessageAsRead(7)).resolves.toBe(true);

      expect(urls(fetchMock).filter((url) => INBOX_PATHS.test(url))).toEqual([]);
      expect(document.getElementById('Grovs-modal')).toBeNull();
      expect(document.querySelector('.grovs-page-modal')).toBeNull();
    });

    it('never calls an inbox endpoint after configure()', async () => {
      const fetchMock = stubFetch();
      await Grovs.configure({ apiKey: 'k' });
      expect(Grovs.isAuthenticated()).toBe(true);
      Grovs.track('something');
      await Grovs.flush();
      Grovs.reset();
      await Grovs.configure({ apiKey: 'k' });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(urls(fetchMock).length).toBeGreaterThan(0);
      expect(urls(fetchMock).filter((url) => INBOX_PATHS.test(url))).toEqual([]);
    });

    it('still accepts messagesTheme, silently', async () => {
      stubFetch();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const onError = vi.fn();

      await expect(
        Grovs.configure({
          apiKey: 'k',
          onError,
          messagesTheme: { mode: 'dark', position: 'right', title: 'Inbox', accentColor: '#f00', zIndex: 10 },
        }),
      ).resolves.toBe(true);

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });
  });

  it('applies smartBanner calls made before configure(), latest wins, and keeps hide() across a re-configure', async () => {
    vi.resetModules();
    const { default: Fresh } = await import('../src/index');
    const { SmartBannerController } = await import('../src/smartBanner/controller');
    const setLinkData = vi.spyOn(SmartBannerController.prototype, 'setLinkData');
    const hide = vi.spyOn(SmartBannerController.prototype, 'hide');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    Fresh.smartBanner.setLinkData({ data: { product: '1' } });
    Fresh.smartBanner.setLinkData({ data: { product: '2' } });
    Fresh.smartBanner.hide();
    expect(setLinkData).not.toHaveBeenCalled();
    await Fresh.configure({ apiKey: 'k' });
    expect(setLinkData.mock.calls).toEqual([[{ data: { product: '2' } }]]);
    expect(hide).toHaveBeenCalledTimes(1);

    await Fresh.configure({ apiKey: 'k' });
    expect(hide).toHaveBeenCalledTimes(2);
    Fresh.setEnabled(false);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('drops remembered smartBanner calls after an identity reset from another tab', async () => {
    localStorage.clear();
    document.cookie = 'linksquared=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
    vi.resetModules();
    const { default: Fresh } = await import('../src/index');
    const { SmartBannerController } = await import('../src/smartBanner/controller');
    const setLinkData = vi.spyOn(SmartBannerController.prototype, 'setLinkData');
    const hide = vi.spyOn(SmartBannerController.prototype, 'hide');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    await Fresh.configure({ apiKey: 'k' });
    Fresh.smartBanner.setLinkData({ data: { product: '2' } });
    Fresh.smartBanner.hide();
    expect(setLinkData).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new StorageEvent('storage', { key: 'linksquared', oldValue: 'v1', newValue: null }));

    // A later re-configure (the next visitor's client) must not replay the
    // previous visitor's remembered hide()/setLinkData.
    await Fresh.configure({ apiKey: 'k' });
    expect(setLinkData).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledTimes(1);

    Fresh.setEnabled(false);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('remembers smartBanner calls per hash route', async () => {
    vi.resetModules();
    const { default: Fresh } = await import('../src/index');
    const { SmartBannerController } = await import('../src/smartBanner/controller');
    const setLinkData = vi.spyOn(SmartBannerController.prototype, 'setLinkData');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    history.replaceState({}, '', '/#/product/1');

    Fresh.smartBanner.setLinkData({ data: { product: '1' } });
    history.replaceState({}, '', '/#/product/2');
    await Fresh.configure({ apiKey: 'k' });
    expect(setLinkData).not.toHaveBeenCalled();
    Fresh.setEnabled(false);
    history.replaceState({}, '', '/');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not throw when identity setters are called before configure', () => {
    expect(() => Grovs.setUserIdentifier('x')).not.toThrow();
    expect(() => Grovs.setUserAttributes({ a: 1 })).not.toThrow();
    expect(() => Grovs.setEnabled(false)).not.toThrow();
    expect(() => Grovs.setDebugLevel('info')).not.toThrow();
  });
});
