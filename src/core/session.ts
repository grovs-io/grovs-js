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
  /**
   * The session this tab minted, kept when the store refused to take it.
   *
   * A store can start refusing writes mid-visit — a full origin quota is the
   * common way — and the probe at startup will have succeeded. Reading back
   * null then minted a *new* id on every single read, so consecutive events
   * carried different sessions and time_spent was attributed to none of them.
   * Storage still wins when it has a value: a sibling tab's id is shared and
   * this one is not.
   */
  private memorySessionId: string | null = null;
  /** What was in the store when this tab rotated, so recovery can tell the
   *  id it replaced from one a sibling has written since. */
  private replacedSessionId: string | null = null;
  private memoryActivity: number | null = null;

  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  /** The current session id, rotating first if the shared idle window elapsed. */
  currentSessionId(): string {
    this.rotateIfIdle();
    // Memory first when it holds something: it is only ever set because the
    // store refused our write, and the value still sitting in the store is
    // then the one we tried to replace. Reading it back rotated a session
    // that had already been rotated, over and over.
    let id = this.memorySessionId ?? this.storage.get(SESSION_ID_KEY);
    if (!id) {
      id = randomUUID();
      this.write(SESSION_ID_KEY, id);
    } else if (this.memorySessionId !== null) {
      // The store refused this id when it was minted. Once it takes writes
      // again the id has to go back in, or a sibling reads the one this tab
      // replaced. But only over that same stale value: a sibling that has
      // started a session since owns it, and a session is a person rather
      // than a tab — so adopt theirs instead of overwriting it.
      const stored = this.storage.get(SESSION_ID_KEY);
      if (stored === null || stored === this.replacedSessionId) {
        this.write(SESSION_ID_KEY, this.memorySessionId);
      } else {
        this.memorySessionId = null;
        this.replacedSessionId = null;
        id = stored;
      }
    }
    this.touch();
    return id;
  }

  /** Writes through, and remembers the value when the store refuses it. */
  private write(key: string, value: string): void {
    const stored = this.storage.set(key, value);
    if (key === SESSION_ID_KEY) this.memorySessionId = stored ? null : value;
    else this.memoryActivity = stored ? null : Number(value);
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

    this.replacedSessionId = this.storage.get(SESSION_ID_KEY);
    this.write(SESSION_ID_KEY, randomUUID());
    this.cachedActivity = null;
    this.touch();
    return true;
  }

  reset(): void {
    this.cachedActivity = null;
    this.memorySessionId = null;
    this.replacedSessionId = null;
    this.memoryActivity = null;
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
      this.write(SESSION_ACTIVITY_KEY, String(now));
      return;
    }

    if (last !== null && last > now) return;
    if (this.cachedActivity !== null && now - this.cachedActivity < 1000) return;
    this.cachedActivity = now;
    this.write(SESSION_ACTIVITY_KEY, String(now));
  }

  private lastActivity(): number | null {
    const raw = this.storage.get(SESSION_ACTIVITY_KEY);
    const parsed = raw === null ? null : Number(raw);
    const stored = parsed !== null && Number.isFinite(parsed) ? parsed : null;
    if (this.memoryActivity === null) return stored;
    if (stored === null) return this.memoryActivity;
    // The newer of the two. The field is monotonic, a sibling tab may have
    // moved it on, and our own refused write is only in memory — taking the
    // stale stored one would rotate a live session.
    return Math.max(stored, this.memoryActivity);
  }
}
