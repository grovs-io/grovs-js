import type { Clock } from '../core/clock';
import { getDocument, getWindow } from '../core/environment';

export interface LifecycleDeps {
  clock: Clock;
  /** Emits a time_spent event carrying the seconds since the page became visible. */
  onEngagement: (seconds: number) => void;
  /** The byte-bounded keepalive flush. Terminal — pagehide only. */
  onExit: () => void;
  /** A normal flush, for a tab switch the user may well come back from. */
  onHide: () => void;
  /** Returning to the tab. Refreshes the shared session stamp. */
  onForeground?: () => void;
}

/**
 * Page lifecycle → engagement time.
 *
 * v1 listened only for `focus` (grovs_events_manager.js:169-174), which never
 * fires on tab close — so the final time_spent for every session was lost,
 * and that is the majority of the engagement signal.
 *
 * `pagehide` is the reliable terminal event: `beforeunload` and `unload` are
 * unreliable on mobile Safari and suppress the back/forward cache.
 * `visibilitychange` catches tab switches, which `pagehide` does not.
 */
export class LifecycleTracker {
  private visibleSince: number | null = null;
  private listeners: (() => void)[] = [];

  constructor(private readonly deps: LifecycleDeps) {}

  start(): void {
    const doc = getDocument();
    const win = getWindow();
    if (!doc || !win) return;

    this.visibleSince = doc.visibilityState === 'hidden' ? null : this.deps.clock.now();

    const onVisibilityChange = (): void => {
      if (doc.visibilityState === 'hidden') {
        this.emitEngagement();
        // A tab switch is not an exit. Using the keepalive path here would
        // fire dozens of times a session, each one a request whose result is
        // never checked; a normal flush retries on failure.
        this.deps.onHide();
      } else {
        this.visibleSince = this.deps.clock.now();
        // The session stamp is only written when an event is queued, so a tab
        // left hidden for 29 minutes carries a 29-minute-old one. Without
        // refreshing it here, the next hide reads it as stale and rotates —
        // filing the engagement that just happened under a new session.
        this.deps.onForeground?.();
      }
    };

    const onPageHide = (): void => {
      this.emitEngagement();
      this.deps.onExit();
    };

    doc.addEventListener('visibilitychange', onVisibilityChange);
    win.addEventListener('pagehide', onPageHide);

    this.listeners.push(
      () => doc.removeEventListener('visibilitychange', onVisibilityChange),
      () => win.removeEventListener('pagehide', onPageHide),
    );
  }

  stop(): void {
    for (const remove of this.listeners) remove();
    this.listeners = [];
    this.visibleSince = null;
  }

  private emitEngagement(): void {
    if (this.visibleSince === null) return;
    const seconds = Math.floor((this.deps.clock.now() - this.visibleSince) / 1000);
    // Consume the window either way, so a visibilitychange immediately
    // followed by pagehide cannot double-count the same seconds.
    this.visibleSince = null;
    if (seconds > 0) this.deps.onEngagement(seconds);
  }
}
