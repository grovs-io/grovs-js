import { getDocument, getWindow } from '../core/environment';
import { NavigationObserver } from './navigation';
import type { ScreenAliases } from './screen-aliases';

export { __resetPatchOwner } from './navigation';

/** Returned by a screenNameProvider to override or suppress a screen. */
export type ScreenNameDecision = string | 'suppress' | 'automatic';
export type ScreenNameProvider = (url: URL) => ScreenNameDecision;

export interface AutoScreenTrackerDeps {
  aliases: ScreenAliases;
  onScreen: (name: string) => void;
}

/** SPA route tracking; the History patch lives in navigation.ts. */
export class AutoScreenTracker {
  screenNameProvider: ScreenNameProvider | null = null;
  private readonly observer = new NavigationObserver('screens', {
    settled: () => this.trackCurrent(),
  });

  constructor(private readonly deps: AutoScreenTrackerDeps) {}

  start(): void {
    this.observer.start();
  }

  stop(): void {
    this.observer.stop();
  }

  private trackCurrent(): void {
    const win = getWindow();
    if (!win) return;

    let url: URL;
    try {
      url = new URL(win.location.href);
    } catch {
      return;
    }

    const name = this.resolveName(url);
    if (name === null) return;
    this.deps.onScreen(name);
  }

  /** Priority order matches iOS: provider, then aliases, then automatic. */
  private resolveName(url: URL): string | null {
    if (this.screenNameProvider) {
      let decision: ScreenNameDecision;
      try {
        decision = this.screenNameProvider(url);
      } catch {
        // An integrator's throwing resolver must not stop navigation tracking.
        decision = 'automatic';
      }
      if (decision === 'suppress') return null;
      if (decision !== 'automatic' && decision) return decision;
    }

    const aliased = this.deps.aliases.resolve(url.pathname);
    if (aliased) return aliased;

    const title = getDocument()?.title?.trim();
    if (title) return title;

    return url.pathname || '/';
  }
}
