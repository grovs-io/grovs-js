import { getDocument, getWindow } from '../core/environment';
import type { ScreenAliases } from './screen-aliases';

/** Returned by a screenNameProvider to override or suppress a screen. */
export type ScreenNameDecision = string | 'suppress' | 'automatic';
export type ScreenNameProvider = (url: URL) => ScreenNameDecision;

/** Marks our patch so a second configure() cannot install a second one. */
const PATCH_MARKER = Symbol.for('grovs.historyPatch');

interface PatchedFn {
  [PATCH_MARKER]?: boolean;
}

export interface AutoScreenTrackerDeps {
  aliases: ScreenAliases;
  onScreen: (name: string) => void;
}

/**
 * SPA route tracking via the History API.
 *
 * GA4, Segment and Hotjar patch the same two functions, so three rules apply
 * and none is optional (spec A7):
 *
 *  - **Chain.** The previous implementation is captured and always called. A
 *    patch that does not is why a customer's GA4 goes quiet, and they will
 *    blame the other vendor first and Grovs eventually.
 *  - **Guard.** A symbol marks the patch, so React strict mode and hot reload
 *    calling configure() twice cannot double-count every navigation.
 *  - **Release.** Originals are restored on disable. When another library
 *    patched *after* us, restoring would clobber theirs — so in that case the
 *    patch stays installed and goes inert, which is the stated behaviour
 *    rather than a silent fallback.
 */
export class AutoScreenTracker {
  private enabled = false;
  private installed = false;
  private originalPushState: History['pushState'] | null = null;
  private originalReplaceState: History['replaceState'] | null = null;
  private listeners: (() => void)[] = [];
  private frame: number | null = null;
  /** rAF does not fire in a hidden tab, so the handle may be a timeout id —
   *  and the two cancel functions are not interchangeable. */
  private frameIsTimeout = false;

  screenNameProvider: ScreenNameProvider | null = null;

  constructor(private readonly deps: AutoScreenTrackerDeps) {}

  start(): void {
    const win = getWindow();
    if (!win) return;

    this.enabled = true;
    // Already patched, but re-entry still owes the caller the current screen.
    if (this.installed) {
      this.trackCurrent();
      return;
    }

    const history = win.history;
    const push = history.pushState as History['pushState'] & PatchedFn;

    // Guard: someone else's patch is fine to chain onto, but ours is not.
    if (push[PATCH_MARKER]) {
      this.installed = true;
      this.trackCurrent();
      return;
    }

    this.originalPushState = history.pushState;
    this.originalReplaceState = history.replaceState;

    // Arrow functions over the captured `history`, rather than relying on the
    // dynamic `this` of the call site. Chain first in both: the host's
    // navigation must happen even if our tracking throws.
    const patchedPush = ((...args: Parameters<History['pushState']>): void => {
      this.originalPushState?.apply(history, args);
      this.scheduleTrack();
    }) as History['pushState'] & PatchedFn;
    patchedPush[PATCH_MARKER] = true;

    const patchedReplace = ((...args: Parameters<History['replaceState']>): void => {
      this.originalReplaceState?.apply(history, args);
      this.scheduleTrack();
    }) as History['replaceState'] & PatchedFn;
    patchedReplace[PATCH_MARKER] = true;

    history.pushState = patchedPush;
    history.replaceState = patchedReplace;

    const onPopState = (): void => this.scheduleTrack();
    const onHashChange = (): void => this.scheduleTrack();
    win.addEventListener('popstate', onPopState);
    win.addEventListener('hashchange', onHashChange);
    this.listeners.push(
      () => win.removeEventListener('popstate', onPopState),
      () => win.removeEventListener('hashchange', onHashChange),
    );

    this.installed = true;
    this.trackCurrent();
  }

  /**
   * Stops tracking and restores the originals when it is safe to do so.
   *
   * "Safe" means our patch is still the installed one. If another library
   * patched after us, its wrapper closed over ours; writing the pre-Grovs
   * function back would silently uninstall theirs.
   */
  stop(): void {
    this.enabled = false;

    const win = getWindow();
    if (!win || !this.installed) return;

    this.cancelPending(win);

    for (const remove of this.listeners) remove();
    this.listeners = [];

    const current = win.history.pushState as History['pushState'] & PatchedFn;
    if (current[PATCH_MARKER] && this.originalPushState && this.originalReplaceState) {
      win.history.pushState = this.originalPushState;
      win.history.replaceState = this.originalReplaceState;
      this.installed = false;
    }
    // Otherwise the patch stays installed and inert — `enabled` is false, so
    // scheduleTrack() does nothing.
  }

  /**
   * Resolution is deferred one animation frame.
   *
   * A patched pushState runs *before* the framework commits its render, so
   * reading document.title at patch time returns the previous page's title.
   * One frame later it reads the title the user actually sees. This is the
   * whole reason framework adapters were considered, and why they were
   * dropped — the deferral covers every framework, including the ones that
   * were never going to get an adapter.
   */
  private scheduleTrack(): void {
    if (!this.enabled) return;
    const win = getWindow();
    if (!win) return;

    this.cancelPending(win);

    const run = (): void => {
      this.frame = null;
      this.trackCurrent();
    };

    // requestAnimationFrame does not fire in a hidden tab, so a background
    // navigation would sit unresolved until the tab is looked at again — and
    // then collapse to whatever the last URL happened to be.
    const hidden = getDocument()?.visibilityState === 'hidden';
    if (!hidden && win.requestAnimationFrame) {
      this.frameIsTimeout = false;
      this.frame = win.requestAnimationFrame(run);
    } else {
      this.frameIsTimeout = true;
      this.frame = setTimeout(run, 0) as unknown as number;
    }
  }

  private cancelPending(win: Window): void {
    if (this.frame === null) return;
    if (this.frameIsTimeout) clearTimeout(this.frame);
    else win.cancelAnimationFrame?.(this.frame);
    this.frame = null;
  }

  private trackCurrent(): void {
    if (!this.enabled) return;

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
