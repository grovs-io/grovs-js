import type { Clock } from '../core/clock';
import type { QueuedEvent } from '../events/event';
import type { Storage } from './storage';

export const QUEUE_STORAGE_KEY = 'grovs_events';

/** Matches EventsHandler.Constants.maxEventAgeDays on iOS. */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Not on iOS: an offline browser tab can grow localStorage without bound. */
const MAX_EVENTS = 1000;
/**
 * The count cap alone does not bound the write: a thousand events carrying
 * the permitted 8 KB of properties is 8 MB, past every browser's per-origin
 * quota, and a refused write leaves storage holding an old snapshot while
 * memory grows — everything since is lost on reload. One million characters
 * (localStorage quotas count UTF-16 units, not bytes) leaves room for the
 * host page's own use of it. Enforced where the snapshot is serialized
 * anyway, so it costs no bookkeeping per event.
 */
const MAX_CHARS = 1_000_000;
/**
 * Ids of events this tab has delivered, kept so a merging write does not
 * resurrect them from a snapshot another tab wrote before we sent them. One
 * per delivered event, so the cap bounds a long session; a tombstone only has
 * to outlive the stored snapshot it suppresses.
 */
const MAX_TOMBSTONES = MAX_EVENTS;
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
  /** See MAX_TOMBSTONES. Insertion-ordered, so the cap evicts oldest first. */
  private readonly removedIds = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** Set when the owning client is retired. A request already in flight
   *  cannot be cancelled, but its handler can be stopped from persisting a
   *  snapshot that is now stale. */
  private frozen = false;
  private warnedRefused = false;

  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
    private readonly onDropped?: (count: number, reason: string) => void,
  ) {
    // Nothing the SDK writes exceeds the cap; a hand-edited snapshot might.
    this.events = this.load().slice(-MAX_EVENTS);
  }

  /** Forgets everything in memory without writing: another tab owns the
   *  store now. */
  discard(): void {
    this.events = [];
    this.dirty = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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
    this.evictOldest(Math.max(0, this.events.length - MAX_EVENTS), `${MAX_EVENTS} events`);
    this.schedulePersist();
  }

  /**
   * Oldest-first eviction: the newest events are the ones still worth
   * attributing, and time_spent for a session already over is the least
   * useful thing in the queue.
   */
  private evictOldest(count: number, limit: string, tombstone = true): void {
    if (count <= 0) return;
    const evicted = this.events.splice(0, count);
    // A tombstone is a permanent "this tab delivered it" suppression that
    // merged() applies to every future snapshot. Eviction is not delivery,
    // and an evicted event may be a sibling's that only we happened to be
    // holding — tombstoning it there deletes the sibling's copy for good.
    if (tombstone) this.tombstone(evicted.map((event) => event.id));
    this.onDropped?.(count, `queue exceeded ${limit}`);
  }

  /** Drops events by id. Used for both successful sends and permanent rejects. */
  remove(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    this.events = this.events.filter((event) => !drop.has(event.id));
    this.tombstone(ids);
    this.schedulePersist();
  }

  /**
   * Discards events aged past the maximum and returns what survives.
   * Mirrors iOS's staleness cutoff; the backend's dedup retention window must
   * be at least as long (spec A4).
   */
  pruneStale(): QueuedEvent[] {
    const cutoff = this.clock.now() - MAX_AGE_MS;
    const fresh: QueuedEvent[] = [];
    const expired: string[] = [];
    for (const event of this.events) {
      if (event.createdAt > cutoff) fresh.push(event);
      else expired.push(event.id);
    }

    if (expired.length > 0) {
      this.tombstone(expired);
      this.events = fresh;
      this.onDropped?.(expired.length, `older than ${MAX_AGE_MS / (24 * 60 * 60_000)} days`);
      this.schedulePersist();
    }
    // Callers iterate this; hand out a copy like all() does.
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
    // Minus what this tab already delivered, as merged() does: a sibling's
    // snapshot can still list them.
    const restored = this.load().filter(
      (event) => !known.has(event.id) && !this.removedIds.has(event.id),
    );
    if (restored.length > 0) {
      // Oldest first, so the cap evicts by age as it does everywhere else.
      this.events = [...restored, ...this.events];
      // Adopted events belong to whoever wrote them; dropping them from this
      // tab's memory must not suppress them everywhere.
      this.evictOldest(this.events.length - MAX_EVENTS, `${MAX_EVENTS} events`, false);
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
    // Tombstones deliberately survive: another tab's snapshot still lists
    // events this tab delivered, and the next merged() would write them back.
    this.dirty = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.frozen) return;
    // A blind write, not the merging one persist() performs: reset() promises
    // the stored queue is gone, and a union would read back exactly what it
    // was called to erase.
    try {
      this.dirty = !this.storage.set(QUEUE_STORAGE_KEY, '[]');
    } catch {
      /* memory stays authoritative */
    }
  }

  private tombstone(ids: readonly string[]): void {
    for (const id of ids) this.removedIds.add(id);
    let excess = this.removedIds.size - MAX_TOMBSTONES;
    if (excess <= 0) return;
    for (const id of this.removedIds) {
      this.removedIds.delete(id);
      if (--excess === 0) break;
    }
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
      // Stays dirty when the store refused the write, so pagehide retries
      // instead of short-circuiting on a write that never landed.
      this.dirty = !this.storage.set(QUEUE_STORAGE_KEY, this.snapshot());
      if (this.dirty && !this.warnedRefused) {
        this.warnedRefused = true;
        this.onDropped?.(0, 'storage refused the write; the queue is held in memory only');
      }
    } catch {
      /* the queue could not be serialized — memory stays authoritative */
    }
  }

  /**
   * The serialized union, cut to the count and character caps from the
   * oldest end.
   *
   * Serialized per event and joined, so the same pass yields the sizes the
   * cut needs. Anything of ours that falls off is evicted from memory too:
   * a queue that only exists until the next reload is not a queue. Only our
   * own ids are tombstoned — a sibling's cut events are still that tab's to
   * deliver.
   */
  private snapshot(): string {
    const union = this.merged();
    const parts = union.map((event) => JSON.stringify(event));
    let chars = 2 + Math.max(0, parts.length - 1);
    let start = parts.length;
    while (start > 0 && chars + parts[start - 1]!.length <= MAX_CHARS) {
      start -= 1;
      chars += parts[start]!.length;
    }
    const byChars = start > 0;
    start = Math.max(start, parts.length - MAX_EVENTS);
    if (start > 0) {
      const cut = new Set(union.slice(0, start).map((event) => event.id));
      const mine = this.events.filter((event) => cut.has(event.id)).map((event) => event.id);
      if (mine.length > 0) {
        this.events = this.events.filter((event) => !cut.has(event.id));
        this.tombstone(mine);
        this.onDropped?.(
          mine.length,
          `queue exceeded ${byChars ? `${MAX_CHARS / 1000} K characters` : `${MAX_EVENTS} events`}`,
        );
      }
    }
    return `[${parts.slice(start).join(',')}]`;
  }

  /**
   * This tab's queue unioned with whatever is in the store.
   *
   * Every tab holds its own in-memory queue against one shared key, so a blind
   * write is last-writer-wins: a second tab opened mid-visit erases the first
   * tab's offline events, and they are gone for good once that tab closes.
   *
   * Union by id, minus what this tab has already delivered — otherwise a
   * snapshot another tab wrote before our send resurrects the events it
   * acknowledged. Their events are written back but deliberately not adopted
   * into memory: both tabs sending the same event is the backend's dedup
   * window to absorb (spec A4), losing it is nobody's.
   */
  private merged(): QueuedEvent[] {
    const mine = new Set(this.events.map((event) => event.id));
    const theirs = this.load().filter(
      (event) => !mine.has(event.id) && !this.removedIds.has(event.id),
    );
    if (theirs.length === 0) return this.events;

    return [...theirs, ...this.events].sort((left, right) => left.createdAt - right.createdAt);
  }

  private load(): QueuedEvent[] {
    const raw = this.storage.get(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // A partially-written or hand-edited value must not take the SDK down;
      // events without an id cannot be acked, so they are worthless anyway.
      // Deduplicated by id, so an ack removes every copy.
      const seen = new Set<string>();
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
            typeof (event as QueuedEvent).eventName === 'string') &&
          !seen.has((event as QueuedEvent).id) &&
          seen.add((event as QueuedEvent).id) !== null,
      );
    } catch {
      return [];
    }
  }
}
