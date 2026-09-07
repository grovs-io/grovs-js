import type { Clock } from './clock';
import type { Storage } from '../storage/storage';
import { randomUUID } from './uuid';

export const SESSION_ID_KEY = 'grovs_session_id';
export const SESSION_ACTIVITY_KEY = 'grovs_session_activity';

/** Matches the 30-minute window Context.rotateSessionIfNeeded() uses on iOS. */
const IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * Whether `storage` holds a session still inside the idle window.
 *
 * Consent migration needs this before it copies: another tab may be mid-visit
 * on the durable store, and replacing its session id splits that visit in two.
 */
export function hasActiveSession(storage: Storage, now: number): boolean {
  if (!storage.get(SESSION_ID_KEY)) return false;
  const last = Number(storage.get(SESSION_ACTIVITY_KEY));
  return Number.isFinite(last) && now - last <= IDLE_TIMEOUT_MS;
}

/**
 * A session is a person, not a tab (spec A6).
 *
 * iOS ports a single-process assumption: one app, one session, rotated when
 * the app is backgrounded. A browser gives the same person three tabs, and
 * both naive translations are wrong in a way nothing surfaces — per-tab
 * sessions inflate counts by however many tabs someone opens, and rotating
 * when one tab is hidden rotates the session out from under two that are
 * still active.
 *
 * So the id and a last-activity timestamp both live in shared storage. Any
 * tab's activity refreshes the timestamp; rotation happens when a tab wakes
 * and finds the *shared* last activity older than the timeout. That
 * translates iOS's intent — a session is a period of user activity — rather
 * than its mechanism.
 */
export class SessionManager {
  /** Mirrors the last write so touch() can throttle writes to one a second.
   *  Reads still go to storage — another tab may have moved the stamp. */
  private cachedActivity: number | null = null;

  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  /** The current session id, rotating first if the shared idle window elapsed. */
  currentSessionId(): string {
    this.rotateIfIdle();
    let id = this.storage.get(SESSION_ID_KEY);
    if (!id) {
      id = randomUUID();
      this.storage.set(SESSION_ID_KEY, id);
    }
    this.touch();
    return id;
  }

  /**
   * Rotates when the shared last-activity stamp is older than the timeout.
   * Returns whether a rotation happened, so callers that must reset per-session
   * state (screen-view dedup) can react.
   */
  rotateIfIdle(): boolean {
    const last = this.lastActivity();
    if (last === null) return false;
    if (this.clock.now() - last <= IDLE_TIMEOUT_MS) return false;

    this.storage.set(SESSION_ID_KEY, randomUUID());
    this.cachedActivity = null;
    this.touch();
    return true;
  }

  reset(): void {
    this.cachedActivity = null;
    this.storage.remove(SESSION_ID_KEY);
    this.storage.remove(SESSION_ACTIVITY_KEY);
  }

  /**
   * Last-writer-wins is correct here because the field is monotonic, but it
   * has to be written deliberately as such: two tabs racing must never move
   * the stamp backwards, or an active tab's write could be clobbered by a
   * slower one carrying an older reading.
   *
   * Writes at most once a second. The stamp only has to be accurate to within
   * the 30-minute idle window, and the queue was debounced precisely to stop
   * hammering the same synchronous store on every event.
   */
  private touch(): void {
    const now = this.clock.now();
    const last = this.lastActivity();

    // A stamp further ahead than the idle window itself cannot be another
    // tab racing by milliseconds — it is a clock running fast. Left alone it
    // makes every tab compute a negative idle, so nothing rotates until real
    // time overtakes it: sessions under-counted and durations inflated for
    // the length of the skew. Treat it as corrupt and take the stamp back.
    if (last !== null && last > now + IDLE_TIMEOUT_MS) {
      this.cachedActivity = now;
      this.storage.set(SESSION_ACTIVITY_KEY, String(now));
      return;
    }

    if (last !== null && last > now) return;
    if (this.cachedActivity !== null && now - this.cachedActivity < 1000) return;
    this.cachedActivity = now;
    this.storage.set(SESSION_ACTIVITY_KEY, String(now));
  }

  private lastActivity(): number | null {
    const raw = this.storage.get(SESSION_ACTIVITY_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
