import { getDocument, getWindow } from '../core/environment';

/** Marks our patch so a second configure() cannot install a second one. */
const PATCH_MARKER = Symbol.for('grovs.historyPatch');
const OWNER_KEY = Symbol.for('grovs.historyPatchOwner');

/**
 * The tracker the installed patch reports to, or null when the patch is
 * orphaned — installed but owned by nobody.
 *
 * A retired client cannot always uninstall: when another library wrapped
 * History after us, restoring would clobber theirs, so the patch stays. The
 * marker alone then tells the replacement client "already patched" and it
 * refuses to install, while the tracker the patch actually calls is disabled —
 * SPA tracking silently stops for the rest of the page's life. Ownership is
 * what distinguishes a live owner from a retired one.
 */
interface PatchOwnership {
  notify: () => void;
}

/**
 * The patch actually installed, and the functions it displaced.
 *
 * Shared, because uninstalling is only safe against the exact pair that is
 * installed. A copy of the SDK restoring *its own* captured originals over a
 * patch another copy installed writes the page back to a state that never
 * existed — and takes out any wrappers other libraries chained on since.
 */
interface PatchRecord {
  push: History['pushState'];
  replace: History['replaceState'];
  originalPush: History['pushState'];
  originalReplace: History['replaceState'];
}

/**
 * Ownership lives in the same cross-realm registry as the marker, not in this
 * module.
 *
 * A page can hold two copies of this SDK — a CDN script tag beside an npm
 * install is a configuration customers reach by accident. `Symbol.for` is
 * shared between the copies, so the second one saw the marker and correctly
 * refused to install a second patch. But a module-level owner is not shared,
 * so the installed patch went on reporting to the first copy's tracker and
 * the second never saw a navigation. Once the first stopped, the patch was
 * inert and the marker still said "installed": SPA tracking blind, silently
 * and permanently, for the life of the page.
 *
 * Held in a box rather than assigned onto the patched function, because
 * another library may have wrapped History after us — the patched function is
 * then unreachable, while this box is not.
 *
 * `current` is the screens owner: older SDK copies on the page read and write
 * only that field, so it keeps its old meaning. Every other role lives in
 * `roles`, keyed by role name.
 */
interface OwnerBox {
  current: PatchOwnership | null;
  patch: PatchRecord | null;
  roles?: Record<string, PatchOwnership | null>;
}

interface PatchedFn {
  [PATCH_MARKER]?: boolean;
}

export type NavigationRole = 'screens' | 'smartBanner';

export interface NavigationCallbacks {
  /** Synchronously, on every navigation. */
  immediate?: () => void;
  /** On start, and one animation frame after every navigation. */
  settled: () => void;
}

function ownerBox(): OwnerBox {
  const registry = globalThis as unknown as Record<symbol, OwnerBox | undefined>;
  return (registry[OWNER_KEY] ??= { current: null, patch: null });
}

function getOwner(role: NavigationRole): PatchOwnership | null {
  const box = ownerBox();
  return role === 'screens' ? box.current : (box.roles?.[role] ?? null);
}

function setOwner(role: NavigationRole, owner: PatchOwnership | null): void {
  const box = ownerBox();
  if (role === 'screens') box.current = owner;
  else (box.roles ??= {})[role] = owner;
}

function anyOwner(): boolean {
  const box = ownerBox();
  return box.current !== null || Object.values(box.roles ?? {}).some((owner) => owner !== null);
}

function notify(owner: PatchOwnership | null | undefined): void {
  try {
    owner?.notify();
  } catch {
    // An older SDK copy's owner may throw; the other roles still hear the navigation.
  }
}

function notifyAll(): void {
  try {
    const box = ownerBox();
    notify(box.current);
    for (const owner of Object.values(box.roles ?? {})) notify(owner);
  } catch {
    // Runs inside the host's pushState.
  }
}

/** Test seam: shared state, so it would otherwise leak between tests. */
export function __resetPatchOwner(): void {
  const box = ownerBox();
  box.current = null;
  box.patch = null;
  box.roles = {};
}

/**
 * Shared History-patch observer behind every role (SPA screen tracking, the
 * smart banner) that needs to know about client-side navigation.
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
export class NavigationObserver {
  private enabled = false;
  private installed = false;
  private originalPushState: History['pushState'] | null = null;
  private originalReplaceState: History['replaceState'] | null = null;
  private listeners: (() => void)[] = [];
  private frame: number | null = null;
  /** rAF does not fire in a hidden tab, so the handle may be a timeout id —
   *  and the two cancel functions are not interchangeable. */
  private frameIsTimeout = false;
  /** This observer's identity in the module-level ownership above, and the
   *  way the installed patch reaches it. */
  private readonly ownership: PatchOwnership = { notify: () => this.onNavigate() };

  constructor(
    private readonly role: NavigationRole,
    private readonly callbacks: NavigationCallbacks,
  ) {}

  start(): void {
    const win = getWindow();
    if (!win) return;

    this.enabled = true;

    const history = win.history;
    const push = history.pushState as History['pushState'] & PatchedFn;

    // The shared state, never this instance's memory of it. Another copy of
    // the SDK can have restored the originals since we last looked, and an
    // observer trusting its own `installed` flag then took ownership of a
    // patch that was no longer there and reported nothing for the rest of the
    // page's life. Someone else's patch is fine to chain onto; ours is not.
    if (push[PATCH_MARKER] || ownerBox().patch !== null) {
      // Not the outermost function, or a record with no marker on the live
      // function: either way a Grovs patch already exists somewhere in the
      // chain. Patching again would double-count; not patching keeps this
      // observer reporting through the existing one.
      this.installed = true;
      // Whoever (re)started last owns this role. Leaving a live owner in
      // place instead would strand this observer permanently once that owner
      // stopped: the marker still says installed, so it never re-patches,
      // and the box it reports through is nobody's.
      // stop() detaches the listeners and releases ownership even when the
      // patch has to stay installed, so re-entry owes the caller all three:
      // the listeners, the ownership the patch reports through, and the
      // current state.
      setOwner(this.role, this.ownership);
      this.attachListeners(win);
      this.reportCurrent();
      return;
    }

    this.installed = false;
    this.originalPushState = history.pushState;
    this.originalReplaceState = history.replaceState;

    // Arrow functions over the captured `history`, rather than relying on the
    // dynamic `this` of the call site. Chain first in both: the host's
    // navigation must happen even if our tracking throws.
    // Through notifyAll(), not `this`: the patch outlives the observer that
    // installed it whenever another library wrapped History after us, and it
    // must reach every role, not just this one.
    const patchedPush = ((...args: Parameters<History['pushState']>): void => {
      this.originalPushState?.apply(history, args);
      notifyAll();
    }) as History['pushState'] & PatchedFn;
    patchedPush[PATCH_MARKER] = true;

    const patchedReplace = ((...args: Parameters<History['replaceState']>): void => {
      this.originalReplaceState?.apply(history, args);
      notifyAll();
    }) as History['replaceState'] & PatchedFn;
    patchedReplace[PATCH_MARKER] = true;

    history.pushState = patchedPush;
    history.replaceState = patchedReplace;
    ownerBox().patch = {
      push: patchedPush,
      replace: patchedReplace,
      originalPush: this.originalPushState,
      originalReplace: this.originalReplaceState,
    };

    this.attachListeners(win);

    this.installed = true;
    setOwner(this.role, this.ownership);
    this.reportCurrent();
  }

  /** Back, Forward and fragment navigation arrive as events, not through the
   *  patched History methods. Idempotent, so re-entry is safe. */
  private attachListeners(win: Window): void {
    if (this.listeners.length > 0) return;

    const onNavigate = (): void => this.onNavigate();
    win.addEventListener('popstate', onNavigate);
    win.addEventListener('hashchange', onNavigate);
    this.listeners.push(
      () => win.removeEventListener('popstate', onNavigate),
      () => win.removeEventListener('hashchange', onNavigate),
    );
  }

  /**
   * Stops observing and restores the originals when it is safe to do so.
   *
   * "Safe" means our patch is still the installed one, and no other role
   * still owns it. If another library patched after us, its wrapper closed
   * over ours; writing the pre-Grovs function back would silently uninstall
   * theirs.
   */
  stop(): void {
    this.enabled = false;
    const owned = getOwner(this.role) === this.ownership;
    // Release it whether or not the patch can come out: a replacement client
    // adopts what this one leaves behind.
    if (owned) setOwner(this.role, null);

    const win = getWindow();
    if (!win || !this.installed) return;

    this.cancelPending(win);
    for (const remove of this.listeners) remove();
    this.listeners = [];

    // Someone else owns the patch now — another role, or another copy of the
    // SDK on the page. Taking the patch out from under a live owner would
    // leave it tracking nothing. Detach and go quiet instead; whoever owns it
    // keeps working.
    if (!owned || anyOwner()) return;

    // By identity against the shared record, not by the marker: the marker
    // says "a Grovs patch", which may be another copy's. Restoring this
    // instance's captured originals over that one puts the page back to a
    // state it was never in and silently uninstalls every wrapper other
    // libraries have chained on since. Only the exact installed pair can be
    // undone, and only while it is still outermost — anything wrapping it
    // would be uninstalled with it.
    const record = ownerBox().patch;
    if (
      record &&
      win.history.pushState === record.push &&
      win.history.replaceState === record.replace
    ) {
      win.history.pushState = record.originalPush;
      win.history.replaceState = record.originalReplace;
      ownerBox().patch = null;
      this.installed = false;
    }
    // Otherwise the patch stays installed and inert — `enabled` is false, so
    // onNavigate() does nothing.
  }

  private onNavigate(): void {
    // The patch already routes through the owner, but popstate and hashchange
    // are listeners each role attaches for itself — so without this, two
    // roles on one page both report every Back and every fragment change,
    // while pushState is reported once.
    if (getOwner(this.role) !== this.ownership || !this.enabled) return;
    try {
      this.callbacks.immediate?.();
    } catch {
      // Runs inside the host's pushState: a subscriber error must not break navigation.
    }
    this.scheduleSettled();
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
  private scheduleSettled(): void {
    const win = getWindow();
    if (!win) return;

    this.cancelPending(win);

    const run = (): void => {
      this.frame = null;
      // Again here, not only at scheduling: another copy of the SDK can start
      // and take the patch over in between, and then both report the same
      // navigation — this one from a frame already in the queue.
      if (getOwner(this.role) !== this.ownership) return;
      this.reportCurrent();
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

  private reportCurrent(): void {
    if (!this.enabled) return;
    try {
      this.callbacks.settled();
    } catch {
      // Same guarantee as onNavigate: start() runs inside configure() on the host's page.
    }
  }
}
