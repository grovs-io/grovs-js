import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoScreenTracker } from '../../src/tracking/auto-screen-tracker';
import { ScreenAliases } from '../../src/tracking/screen-aliases';
import { ApiService } from '../../src/net/api';
import { resolveConfig } from '../../src/core/config';
import { Context } from '../../src/core/context';
import { Logger } from '../../src/logging/logger';
import { FakeTransport } from '../helpers/fake-transport';

const originalPushState = history.pushState.bind(history);
const originalReplaceState = history.replaceState.bind(history);

function make(aliases = new ScreenAliases()) {
  const onScreen = vi.fn();
  const tracker = new AutoScreenTracker({ aliases, onScreen });
  return { tracker, onScreen, aliases };
}

/** Drains the deferred resolution, which waits one animation frame. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 32));
}

describe('AutoScreenTracker', () => {
  beforeEach(() => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    history.replaceState({}, '', '/');
    document.title = '';
  });

  afterEach(() => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
  });

  it('reports the current screen on start', () => {
    const { tracker, onScreen } = make();
    tracker.start();
    expect(onScreen).toHaveBeenCalledWith('/');
    tracker.stop();
  });

  it('reports a screen on pushState', async () => {
    const { tracker, onScreen } = make();
    tracker.start();
    onScreen.mockClear();

    history.pushState({}, '', '/checkout');
    await settle();

    expect(onScreen).toHaveBeenCalledWith('/checkout');
    tracker.stop();
  });

  it('reports a screen on popstate', async () => {
    const { tracker, onScreen } = make();
    tracker.start();
    onScreen.mockClear();

    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();

    expect(onScreen).toHaveBeenCalled();
    tracker.stop();
  });

  it('prefers document.title over the pathname', async () => {
    const { tracker, onScreen } = make();
    tracker.start();
    onScreen.mockClear();

    document.title = 'Checkout Page';
    history.pushState({}, '', '/c');
    await settle();

    expect(onScreen).toHaveBeenCalledWith('Checkout Page');
    tracker.stop();
  });

  // Spec A7, rule one. A patch that does not call through is why a customer's
  // GA4 goes quiet — and they blame the other vendor first.
  it('chains onto a pre-existing patch instead of replacing it', async () => {
    const otherVendor = vi.fn();
    const beforeGrovs = history.pushState.bind(history);
    history.pushState = function (...args: Parameters<History['pushState']>) {
      otherVendor();
      beforeGrovs(...args);
    } as History['pushState'];

    const { tracker, onScreen } = make();
    tracker.start();
    onScreen.mockClear();

    history.pushState({}, '', '/after');
    await settle();

    expect(otherVendor).toHaveBeenCalledOnce();
    expect(onScreen).toHaveBeenCalledWith('/after');
    tracker.stop();
  });

  // Spec A7, rule two. React strict mode and hot reload both call configure()
  // twice; without the guard every navigation fires two screen views.
  it('does not double-count when started twice', async () => {
    const { tracker, onScreen } = make();
    tracker.start();
    tracker.start();
    onScreen.mockClear();

    history.pushState({}, '', '/once');
    await settle();

    expect(onScreen).toHaveBeenCalledTimes(1);
    tracker.stop();
  });

  it('does not install a second patch when started twice', () => {
    const { tracker } = make();
    tracker.start();
    const afterFirst = history.pushState;
    tracker.start();
    expect(history.pushState).toBe(afterFirst);
    tracker.stop();
  });

  // Spec A7, rule three.
  it('restores the original functions on stop', () => {
    const { tracker } = make();
    const before = history.pushState;
    tracker.start();
    expect(history.pushState).not.toBe(before);

    tracker.stop();
    expect(history.pushState).toBe(before);
  });

  it('stops reporting after stop', async () => {
    const { tracker, onScreen } = make();
    tracker.start();
    tracker.stop();
    onScreen.mockClear();

    history.pushState({}, '', '/ignored');
    await settle();

    expect(onScreen).not.toHaveBeenCalled();
  });

  // When another library patched after us, restoring would silently uninstall
  // theirs. Going inert is the stated behaviour.
  it('goes inert rather than clobbering a later vendor patch', async () => {
    const { tracker, onScreen } = make();
    tracker.start();

    const laterVendor = vi.fn();
    const grovsPatch = history.pushState.bind(history);
    history.pushState = function (...args: Parameters<History['pushState']>) {
      laterVendor();
      grovsPatch(...args);
    } as History['pushState'];
    const afterLaterVendor = history.pushState;

    tracker.stop();
    expect(history.pushState).toBe(afterLaterVendor);

    onScreen.mockClear();
    history.pushState({}, '', '/x');
    await settle();

    expect(laterVendor).toHaveBeenCalled();
    expect(onScreen).not.toHaveBeenCalled();
  });

  describe('screenNameProvider', () => {
    it('overrides the resolved name', async () => {
      const { tracker, onScreen } = make();
      tracker.screenNameProvider = () => 'Custom Name';
      tracker.start();
      expect(onScreen).toHaveBeenCalledWith('Custom Name');
      tracker.stop();
    });

    it('suppresses a screen entirely', () => {
      const { tracker, onScreen } = make();
      tracker.screenNameProvider = () => 'suppress';
      tracker.start();
      expect(onScreen).not.toHaveBeenCalled();
      tracker.stop();
    });

    it('falls through to automatic resolution', () => {
      const { tracker, onScreen } = make();
      tracker.screenNameProvider = () => 'automatic';
      tracker.start();
      expect(onScreen).toHaveBeenCalledWith('/');
      tracker.stop();
    });

    it('receives the full URL', () => {
      const { tracker } = make();
      const seen: URL[] = [];
      tracker.screenNameProvider = (url) => {
        seen.push(url);
        return 'automatic';
      };
      tracker.start();
      expect(seen[0]).toBeInstanceOf(URL);
      expect(seen[0]?.pathname).toBe('/');
      tracker.stop();
    });

    // An integrator's bug must not stop navigation tracking.
    it('falls back to automatic when the provider throws', () => {
      const { tracker, onScreen } = make();
      tracker.screenNameProvider = () => {
        throw new Error('integrator bug');
      };
      tracker.start();
      expect(onScreen).toHaveBeenCalledWith('/');
      tracker.stop();
    });
  });
});

describe('ScreenAliases', () => {
  it('matches an exact path', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/checkout': 'Checkout' });
    expect(aliases.resolve('/checkout')).toBe('Checkout');
  });

  it('returns null when nothing matches', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/checkout': 'Checkout' });
    expect(aliases.resolve('/other')).toBeNull();
  });

  // The web-only addition: without pattern collapsing a catalogue of any size
  // floods the dashboard with one row per product id.
  it('collapses a parameterised segment', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/product/:id': 'Product' });
    expect(aliases.resolve('/product/1')).toBe('Product');
    expect(aliases.resolve('/product/abc-999')).toBe('Product');
  });

  it('does not let a parameter span a path separator', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/product/:id': 'Product' });
    expect(aliases.resolve('/product/1/reviews')).toBeNull();
  });

  it('supports a wildcard that spans separators', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/docs/*': 'Docs' });
    expect(aliases.resolve('/docs/a/b/c')).toBe('Docs');
  });

  it('prefers the more specific pattern', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/product/:id': 'Product', '/product/new': 'New Product' });
    expect(aliases.resolve('/product/new')).toBe('New Product');
    expect(aliases.resolve('/product/42')).toBe('Product');
  });

  it('tolerates a trailing slash', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/checkout': 'Checkout' });
    expect(aliases.resolve('/checkout/')).toBe('Checkout');
  });

  // Regex metacharacters in a path must not alter the match.
  it('escapes regex metacharacters in the pattern', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/a.b': 'Dotted' });
    expect(aliases.resolve('/a.b')).toBe('Dotted');
    expect(aliases.resolve('/axb')).toBeNull();
  });

  // Spec B8: the backend caps each request at 200.
  it('chunks a 201-entry map into two requests of 200 and 1', async () => {
    const transport = new FakeTransport();
    const api = new ApiService(
      resolveConfig({ apiKey: 'k' }),
      new Context(),
      transport,
      () => 'https://x',
    );

    const map: Record<string, string> = {};
    for (let i = 0; i < 201; i += 1) map[`/p${i}`] = `Page ${i}`;

    const aliases = new ScreenAliases();
    aliases.set(map);
    await aliases.sync(api, new Logger());

    const requests = transport.requestsTo('/screen_aliases');
    expect(requests).toHaveLength(2);
    expect((requests[0]?.body as { screen_aliases: unknown[] }).screen_aliases).toHaveLength(200);
    expect((requests[1]?.body as { screen_aliases: unknown[] }).screen_aliases).toHaveLength(1);
  });

  it('stops syncing after a failed chunk', async () => {
    const transport = new FakeTransport();
    transport.enqueueStatus(500);
    const api = new ApiService(
      resolveConfig({ apiKey: 'k' }),
      new Context(),
      transport,
      () => 'https://x',
    );

    const map: Record<string, string> = {};
    for (let i = 0; i < 400; i += 1) map[`/p${i}`] = `Page ${i}`;

    const aliases = new ScreenAliases();
    aliases.set(map);
    await aliases.sync(api, new Logger());

    expect(transport.requestsTo('/screen_aliases')).toHaveLength(1);
  });

  it('sends identifier and alias pairs', async () => {
    const transport = new FakeTransport();
    const api = new ApiService(
      resolveConfig({ apiKey: 'k' }),
      new Context(),
      transport,
      () => 'https://x',
    );

    const aliases = new ScreenAliases();
    aliases.set({ '/checkout': 'Checkout' });
    await aliases.sync(api, new Logger());

    expect(transport.last?.body).toEqual({
      screen_aliases: [{ identifier: '/checkout', alias: 'Checkout' }],
    });
  });
});
