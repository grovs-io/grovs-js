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

  // The re-entry branch reports on every start; the handler's 1s same-name
  // dedup is what stops it reaching the dashboard twice.
  it('re-reports the current screen on a second start', () => {
    const { tracker, onScreen } = make();
    tracker.start();
    tracker.start();
    expect(onScreen).toHaveBeenCalledTimes(2);
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

  it('reports the current screen when re-enabled over its own patch', async () => {
    const { tracker, onScreen } = make();
    tracker.start();
    tracker.stop();

    // Re-arm over a foreign patch, so stop() leaves `installed` set.
    tracker.start();
    const grovsPatch = history.pushState.bind(history);
    history.pushState = function (...args: Parameters<History['pushState']>) {
      grovsPatch(...args);
    } as History['pushState'];
    tracker.stop();

    onScreen.mockClear();
    tracker.start();
    await settle();

    expect(onScreen).toHaveBeenCalledTimes(1);
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

describe('re-enabling after another library patched over us', () => {
  // The same reset the main suite uses: these tests read the URL back as the
  // screen name, so a title or a patch left by an earlier test would decide it.
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

  // stop() cannot restore the originals once someone else's wrapper closed
  // over ours, so the patch stays installed and inert. start() then took the
  // "already installed" path and returned without re-attaching the listeners
  // it had removed: pushState kept tracking, Back and Forward did not.
  it('restores popstate tracking on re-enable', async () => {
    const { tracker, onScreen } = make();
    tracker.start();

    // Another library patches after us and does not mark its wrapper.
    const ours = history.pushState;
    history.pushState = function patchedByGA(...args: Parameters<History['pushState']>) {
      return (ours as History['pushState']).apply(history, args);
    } as History['pushState'];

    tracker.stop();
    tracker.start();
    onScreen.mockClear();

    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();

    expect(onScreen).toHaveBeenCalled();
    tracker.stop();
  });

  // A reconfigure retires one tracker and starts another. When the patch
  // cannot be uninstalled, the replacement used to see the marker, refuse to
  // install, and report to nobody — SPA tracking dead for the page's life.
  it('lets a replacement adopt a patch the retired tracker could not remove', async () => {
    const first = make();
    first.tracker.start();

    // Another library wraps replaceState after us, so stop() must leave ours in.
    const ours = history.replaceState;
    history.replaceState = function wrapped(...args: Parameters<History['replaceState']>) {
      return (ours as History['replaceState']).apply(history, args);
    } as History['replaceState'];

    first.tracker.stop();

    const second = make();
    second.tracker.start();
    first.onScreen.mockClear();
    second.onScreen.mockClear();

    history.pushState({}, '', '/adopted');
    await settle();

    expect(second.onScreen).toHaveBeenCalledWith('/adopted');
    expect(first.onScreen).not.toHaveBeenCalled();
    second.tracker.stop();
  });

  // Two live clients on one page stays unsupported, but it
  // has to fail safely: exactly one of them tracks, and the one that started
  // most recently is it — the same rule the facade applies when a second
  // configure() replaces the client.
  //
  // The alternative, letting the first owner keep it, strands the second for
  // the life of the page: the marker still reads "installed" so it never
  // re-patches, and once the first stops the patch reports to nobody. That is
  // the dual-copy failure — a CDN script tag beside an npm install.
  it('hands the patch to the most recently started tracker, one owner at a time', async () => {
    const first = make();
    first.tracker.start();

    const second = make();
    second.tracker.start();
    first.onScreen.mockClear();
    second.onScreen.mockClear();

    history.pushState({}, '', '/shared');
    await settle();

    expect(second.onScreen).toHaveBeenCalledWith('/shared');
    expect(first.onScreen).not.toHaveBeenCalled();

    // And the displaced tracker stopping does not take navigation with it.
    first.tracker.stop();
    second.onScreen.mockClear();
    history.pushState({}, '', '/after-first-stops');
    await settle();
    expect(second.onScreen).toHaveBeenCalledWith('/after-first-stops');

    second.tracker.stop();
  });

  // The dual-copy case: a CDN script tag beside an npm install. Two real
  // module instances, so each has its own module scope, exactly as two
  // bundles on one page would. `Symbol.for` is shared between them, which is
  // why the marker was seen and the owner was not.
  it('a second copy of the SDK on the page still sees navigation', async () => {
    const copyA = await import('../../src/tracking/auto-screen-tracker');
    vi.resetModules();
    const copyB = await import('../../src/tracking/auto-screen-tracker');
    expect(copyB.AutoScreenTracker).not.toBe(copyA.AutoScreenTracker);

    const onA = vi.fn();
    const onB = vi.fn();
    const a = new copyA.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: onA });
    const b = new copyB.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: onB });

    a.start();
    b.start();
    onA.mockClear();
    onB.mockClear();

    history.pushState({}, '', '/spa');
    await settle();
    expect(onB).toHaveBeenCalledWith('/spa');
    expect(onA).not.toHaveBeenCalled();

    // The first copy going away must not blind the second for the rest of
    // the page's life, which is what a module-local owner did.
    a.stop();
    onB.mockClear();
    history.pushState({}, '', '/after-the-other-copy-stopped');
    await settle();
    expect(onB).toHaveBeenCalledWith('/after-the-other-copy-stopped');

    b.stop();
    copyB.__resetPatchOwner();
  });

  // pushState goes through the shared owner, but popstate and hashchange are
  // listeners each copy attaches for itself — so Back and fragment changes
  // were reported by every copy on the page while pushState was reported once.
  it('reports Back once when two copies of the SDK are loaded', async () => {
    const copyA = await import('../../src/tracking/auto-screen-tracker');
    vi.resetModules();
    const copyB = await import('../../src/tracking/auto-screen-tracker');

    const onA = vi.fn();
    const onB = vi.fn();
    const a = new copyA.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: onA });
    const b = new copyB.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: onB });
    a.start();
    b.start();
    onA.mockClear();
    onB.mockClear();

    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();

    expect(onB).toHaveBeenCalledTimes(1);
    expect(onA).not.toHaveBeenCalled();

    a.stop();
    b.stop();
    copyB.__resetPatchOwner();
  });

  // A frame scheduled by the owner, then a second copy takes the patch over
  // before it runs. Both would report the same navigation.
  it('drops a deferred report when the patch changed hands before the frame ran', async () => {
    const copyA = await import('../../src/tracking/auto-screen-tracker');
    vi.resetModules();
    const copyB = await import('../../src/tracking/auto-screen-tracker');

    const onA = vi.fn();
    const onB = vi.fn();
    const a = new copyA.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: onA });
    a.start();
    onA.mockClear();

    // A owns the patch and schedules a frame for this navigation.
    history.pushState({}, '', '/mid-flight');

    // B starts before that frame runs and takes ownership.
    const b = new copyB.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: onB });
    b.start();
    onB.mockClear();
    await settle();

    expect(onA).not.toHaveBeenCalled();

    a.stop();
    b.stop();
    copyB.__resetPatchOwner();
  });

  // The full disable/enable interleaving between two independently bundled
  // copies. The second copy adopted the first's patch, so it never captured
  // originals; when the first later restored them, the second was left
  // holding an `installed` flag for a patch that no longer existed.
  it('re-patches when the other copy removed the shared patch', async () => {
    const copyA = await import('../../src/tracking/auto-screen-tracker');
    vi.resetModules();
    const copyB = await import('../../src/tracking/auto-screen-tracker');

    const onB = vi.fn();
    const a = new copyA.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: vi.fn() });
    const b = new copyB.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: onB });

    a.start();
    b.start();

    a.stop();
    a.start();
    a.stop(); // A owns it by now, so this one really does uninstall.

    b.stop();
    b.start();
    onB.mockClear();

    history.pushState({}, '', '/after-the-other-copy-uninstalled');
    await settle();

    expect(onB).toHaveBeenCalledWith('/after-the-other-copy-uninstalled');
    b.stop();
    copyB.__resetPatchOwner();
  });

  // Uninstalling is only safe against the exact pair that is installed. A
  // copy restoring its own captured originals over another copy's patch
  // writes the page back to a state it was never in, taking out every
  // wrapper other libraries chained on since.
  it('never uninstalls another copy\'s patch, or the wrappers on top of it', async () => {
    const copyA = await import('../../src/tracking/auto-screen-tracker');
    vi.resetModules();
    const copyB = await import('../../src/tracking/auto-screen-tracker');

    const a = new copyA.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: vi.fn() });
    const b = new copyB.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: vi.fn() });
    a.start();
    b.start();

    // Another vendor wraps both methods after the SDK is in place.
    const vendorPush = vi.fn();
    const vendorReplace = vi.fn();
    const grovsPush = history.pushState.bind(history);
    const grovsReplace = history.replaceState.bind(history);
    history.pushState = function (...args: Parameters<History['pushState']>) {
      vendorPush();
      grovsPush(...args);
    } as History['pushState'];
    history.replaceState = function (...args: Parameters<History['replaceState']>) {
      vendorReplace();
      grovsReplace(...args);
    } as History['replaceState'];

    b.stop();
    b.start();
    a.stop();
    a.start();
    a.stop();

    vendorPush.mockClear();
    vendorReplace.mockClear();
    history.pushState({}, '', '/still-instrumented');
    history.replaceState({}, '', '/still-instrumented');

    // The other library's instrumentation is still running.
    expect(vendorPush).toHaveBeenCalledTimes(1);
    expect(vendorReplace).toHaveBeenCalledTimes(1);

    b.stop();
    copyB.__resetPatchOwner();
  });

  // The copy that uninstalls need not be the copy that installed. An adopting
  // copy captured no originals of its own, so it can only put back what the
  // shared record holds.
  it('a copy that adopted the patch restores the right originals', async () => {
    const before = history.pushState;
    const copyA = await import('../../src/tracking/auto-screen-tracker');
    vi.resetModules();
    const copyB = await import('../../src/tracking/auto-screen-tracker');

    const a = new copyA.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: vi.fn() });
    const b = new copyB.AutoScreenTracker({ aliases: new ScreenAliases(), onScreen: vi.fn() });
    a.start();
    // B adopts A's patch and, starting last, owns it.
    b.start();

    // B is the one told to stop while the patch is still installed.
    b.stop();

    expect(history.pushState).toBe(before);
    expect(() => history.pushState({}, '', '/works')).not.toThrow();

    a.stop();
    copyB.__resetPatchOwner();
  });

  // Restarting the same tracker over a patch it could not uninstall: stop()
  // released ownership, so the patch called nobody until start() takes it back.
  it('reclaims ownership when restarted over its own retained patch', async () => {
    const { tracker, onScreen } = make();
    tracker.start();

    const ours = history.pushState;
    history.pushState = function wrapped(...args: Parameters<History['pushState']>) {
      return (ours as History['pushState']).apply(history, args);
    } as History['pushState'];

    tracker.stop();
    tracker.start();
    onScreen.mockClear();

    history.pushState({}, '', '/after-restart');
    await settle();

    expect(onScreen).toHaveBeenCalledWith('/after-restart');
    tracker.stop();
  });

  it('does not attach a second pair of listeners on re-entry', async () => {
    const { tracker, onScreen } = make();
    tracker.start();
    tracker.start();
    onScreen.mockClear();

    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();

    expect(onScreen).toHaveBeenCalledTimes(1);
    tracker.stop();
  });
});
