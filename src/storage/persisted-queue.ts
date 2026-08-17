import type { Clock } from '../core/clock';
import type { QueuedEvent } from '../events/event';
import type { Storage } from './storage';

export const QUEUE_STORAGE_KEY = 'grovs_events';

/** Matches EventsHandler.Constants.maxEventAgeDays on iOS. */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Not on iOS: an offline browser tab can grow localStorage without bound. */
const MAX_EVENTS = 1000;
/** Memory is authoritative; storage catches up on this cadence. */
const PERSIST_DEBOUNCE_MS = 1000;

/**
 * The event queue: capped, TTL-pruned, keyed by event_id, debounced.
 *
 * Persistence is debounced because v1 re-serialized the entire array on every
 * write (grovs_events_manager.js:47-58 calls JSON.stringify over the whole
 * queue per storeEvent, and setPathIfNeeded/setSecondsToEvents each add a
 * read-all/write-all pair). localStorage.setItem is synchronous, so that cost
 * lands on the main thread: O(n) per event and O(n²) across a session, with a
 * page that stutters more the longer someone browses.
 *
 * Memory is authoritative. Storage is written on a ~1s debounce and forced
 * synchronously on pagehide. The window costs at most one second of events to
 * a hard crash, which is the right trade against the stutter.
 *
 * Removal is by event_id. v1 filtered by object identity, which cannot
 * survive the JSON round-trip a page reload performs.
 */
export class PersistedQueue {
  private events: QueuedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** Set when the owning client is retired. A request already in flight
   *  cannot be cancelled, but its handler can be stopped from persisting a
   *  snapshot that is now stale. */
  private frozen = false;

  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
    private readonly onDropped?: (count: number, reason: string) => void,
  ) {
    this.events = this.load();
  }

  /** A copy: callers must not be able to mutate the queue's own array. */
  all(): QueuedEvent[] {
    return [...this.events];
  }

  size(): number {
    return this.events.length;
  }

  add(event: QueuedEvent): void {
    this.events.push(event);

    if (this.events.length > MAX_EVENTS) {
      // Oldest-first eviction: the newest events are the ones still worth
      // attributing, and time_spent for a session already over is the least
      // useful thing in the queue.
      const overflow = this.events.length - MAX_EVENTS;
      this.events.splice(0, overflow);
      this.onDropped?.(overflow, `queue exceeded ${MAX_EVENTS} events`);
    }

    this.schedulePersist();
  }

  /** Drops events by id. Used for both successful sends and permanent rejects. */
  remove(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    this.events = this.events.filter((event) => !drop.has(event.id));
    this.schedulePersist();
  }

  /**
   * Discards events aged past the maximum and returns what survives.
   * Mirrors iOS's staleness cutoff; the backend's dedup retention window must
   * be at least as long (spec A4).
   */
  pruneStale(): QueuedEvent[] {
    const cutoff = this.clock.now() - MAX_AGE_MS;
    const fresh = this.events.filter((event) => event.createdAt > cutoff);
    // Callers iterate this; hand out a copy like all() does.
    const dropped = this.events.length - fresh.length;
    if (dropped > 0) {
      this.events = fresh;
      this.onDropped?.(dropped, `older than ${MAX_AGE_MS / (24 * 60 * 60_000)} days`);
      this.schedulePersist();
    }
    return [...this.events];
  }

  /** Applies a mutation to every event, e.g. back-filling a resolved path. */
  transform(fn: (event: QueuedEvent) => QueuedEvent): void {
    this.events = this.events.map(fn);
    this.schedulePersist();
  }

  /**
   * Folds anything already in the backing store into the in-memory queue,
   * then persists the union.
   *
   * Used when consent repoints storage: the queue was constructed over empty
   * memory, so it knows nothing about events a previous visit left behind,
   * and an unconditional write would erase them.
   */
  mergeFromStorage(): void {
    const known = new Set(this.events.map((event) => event.id));
    const restored = this.load().filter((event) => !known.has(event.id));
    if (restored.length > 0) {
      // Oldest first, so the cap evicts by age as it does everywhere else.
      this.events = [...restored, ...this.events].slice(-MAX_EVENTS);
    }
    this.dirty = true;
    this.flushToStorage();
  }

  freeze(): void {
    this.frozen = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Forces a synchronous write. Called on pagehide, where a timer will not fire. */
  flushToStorage(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.persist();
  }

  clear(): void {
    this.events = [];
    this.flushToStorageForced();
  }

  private flushToStorageForced(): void {
    this.dirty = true;
    this.flushToStorage();
  }

  private schedulePersist(): void {
    if (this.frozen) return;
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private persist(): void {
    if (this.frozen) return;
    try {
      this.storage.set(QUEUE_STORAGE_KEY, JSON.stringify(this.events));
      this.dirty = false;
    } catch {
      /* quota or serialization failure — memory stays authoritative */
    }
  }

  private load(): QueuedEvent[] {
    const raw = this.storage.get(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // A partially-written or hand-edited value must not take the SDK down;
      // events without an id cannot be acked, so they are worthless anyway.
      return parsed.filter(
        (event): event is QueuedEvent =>
          typeof event === 'object' &&
          event !== null &&
          typeof (event as QueuedEvent).id === 'string' &&
          typeof (event as QueuedEvent).createdAt === 'number' &&
          // Without this, a record carrying neither name reaches enrich(),
          // which throws — inside a `void flush()`, so it surfaces as an
          // unhandled rejection and every valid event behind it is blocked
          // on this flush and every future one. The guard existed; it was
          // checking the wrong fields.
          (typeof (event as QueuedEvent).event === 'string' ||
            typeof (event as QueuedEvent).eventName === 'string'),
      );
    } catch {
      return [];
    }
  }
}
