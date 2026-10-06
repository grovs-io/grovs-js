import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationObserver } from '../../src/tracking/navigation';

const originalPushState = history.pushState.bind(history);
const originalReplaceState = history.replaceState.bind(history);

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 32));
}

function make(role: 'screens' | 'smartBanner') {
  const immediate = vi.fn();
  const settled = vi.fn();
  return { observer: new NavigationObserver(role, { immediate, settled }), immediate, settled };
}

describe('NavigationObserver', () => {
  beforeEach(() => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    history.replaceState({}, '', '/');
  });
  afterEach(() => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
  });

  it('reports the current page on start', () => {
    const { observer, settled } = make('smartBanner');
    observer.start();
    expect(settled).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it('calls immediate synchronously and settled a frame later', async () => {
    const { observer, immediate, settled } = make('smartBanner');
    observer.start();
    settled.mockClear();
    history.pushState({}, '', '/a');
    expect(immediate).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    await settle();
    expect(settled).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it('notifies both roles from one patch', async () => {
    const screens = make('screens');
    const banner = make('smartBanner');
    screens.observer.start();
    banner.observer.start();
    const installed = history.pushState;
    screens.settled.mockClear();
    banner.settled.mockClear();

    history.pushState({}, '', '/both');
    await settle();
    expect(screens.settled).toHaveBeenCalledTimes(1);
    expect(banner.settled).toHaveBeenCalledTimes(1);
    expect(history.pushState).toBe(installed);
    screens.observer.stop();
    banner.observer.stop();
  });

  it('keeps the patch while another role still owns it', async () => {
    const screens = make('screens');
    const banner = make('smartBanner');
    screens.observer.start();
    banner.observer.start();
    screens.observer.stop();
    banner.settled.mockClear();

    history.pushState({}, '', '/still');
    await settle();
    expect(banner.settled).toHaveBeenCalledTimes(1);
    banner.observer.stop();
  });

  it('restores the originals when the last role leaves', () => {
    const before = history.pushState;
    const screens = make('screens');
    const banner = make('smartBanner');
    screens.observer.start();
    banner.observer.start();
    banner.observer.stop();
    expect(history.pushState).not.toBe(before);
    screens.observer.stop();
    expect(history.pushState).toBe(before);
  });

  it('stays inert under a library that patched on top', async () => {
    const banner = make('smartBanner');
    banner.observer.start();
    const ours = history.pushState;
    history.pushState = function vendor(...args: Parameters<History['pushState']>) {
      return ours.apply(history, args);
    } as History['pushState'];
    const vendor = history.pushState;

    banner.observer.stop();
    expect(history.pushState).toBe(vendor);
    banner.settled.mockClear();
    history.pushState({}, '', '/after');
    await settle();
    expect(banner.settled).not.toHaveBeenCalled();
  });

  it('reports popstate and hashchange', async () => {
    const { observer, immediate } = make('smartBanner');
    observer.start();
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(immediate).toHaveBeenCalledTimes(2);
    observer.stop();
  });

  it("never breaks the host's pushState when a callback throws", async () => {
    const observer = new NavigationObserver('smartBanner', {
      immediate: () => {
        throw new Error('immediate');
      },
      settled: () => {
        throw new Error('settled');
      },
    });
    expect(() => observer.start()).not.toThrow();
    expect(() => history.pushState({}, '', '/throws')).not.toThrow();
    expect(location.pathname).toBe('/throws');
    await settle();
    observer.stop();
  });

  it("isolates each owner's notify inside the patched History methods", () => {
    const banner = make('smartBanner');
    banner.observer.start();
    // An older SDK copy on the page owns the screens slot and its notify throws.
    const box = (globalThis as unknown as Record<symbol, { current: { notify: () => void } | null }>)[
      Symbol.for('grovs.historyPatchOwner')
    ]!;
    const previous = box.current;
    box.current = {
      notify: () => {
        throw new Error('old copy');
      },
    };
    try {
      expect(() => history.pushState({}, '', '/iso-push')).not.toThrow();
      expect(() => history.replaceState({}, '', '/iso-replace')).not.toThrow();
      expect(location.pathname).toBe('/iso-replace');
      expect(banner.immediate).toHaveBeenCalledTimes(2);
    } finally {
      box.current = previous;
      banner.observer.stop();
    }
  });

  it('reports nothing after stop', async () => {
    const { observer, immediate, settled } = make('smartBanner');
    observer.start();
    observer.stop();
    settled.mockClear();
    history.pushState({}, '', '/x');
    await settle();
    expect(immediate).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });
});
