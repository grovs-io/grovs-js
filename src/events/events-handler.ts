import type { SystemEventName } from '../contract/event-contract';
import type { Clock } from '../core/clock';
import type { SessionManager } from '../core/session';
import { randomUUID } from '../core/uuid';
import type { Logger } from '../logging/logger';
import type { ApiService, BatchResult } from '../net/api';
import { GrovsError } from '../net/errors';
import type { PersistedQueue } from '../storage/persisted-queue';
import { enrich } from './enrich';
import type { QueuedEvent } from './event';

/**
 * Cadence is iOS's, not an implementer's choice. These two numbers determine
 * everything observable about the SDK's network behaviour, which makes them
 * parity constants rather than tuning details.
 */
const BATCH_INTERVAL_MS = 30_000; // CustomEventsHandler.swift:45
const FIRST_BATCH_LEEWAY_MS = 5_000; // EventsHandler.swift:18

/** Matches the backend's MAX_BATCH_SIZE in events_controller.rb. */
const MAX_BATCH_SIZE = 50;

/**
 * Browsers cap all in-flight keepalive bodies at 64 KB combined and reject
 * rather than truncate past it. A 50-event batch of custom events carrying the
 * permitted 8 KB of properties is 400 KB, so the exit flush measures.
 */
const KEEPALIVE_BUDGET_BYTES = 60 * 1024;

export interface EventsHandlerDeps {
  api: ApiService;
  queue: PersistedQueue;
  session: SessionManager;
  clock: Clock;
  logger: Logger;
  /** The deep link path to stamp on events, once resolved. */
  currentPath: () => string | null;
  isEnabled: () => boolean;
}

/**
 * System events, batching, and the flush schedule.
 *
 * v1 emitted nothing at all — grovs_events_manager.js had an addEvent() with
 * no callers — so web reported zero installs, opens and engagement time. This
 * is the gap Phase 1 exists to close.
 */
export class EventsHandler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private leewayTimer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  /** Set once the payload lookup resolves, so events are not sent before their
   *  attribution path is known. Mirrors hasFetchedPayloadLink on iOS. */
  private pathResolved = false;

  constructor(private readonly deps: EventsHandlerDeps) {}

  /**
   * Emits the events iOS emits at launch, following the same rules:
   * install on a first-ever visit, reinstall when an identifier already
   * existed, reactivation after seven days away, and app_open every time.
   */
  start(options: { hasExistingIdentity: boolean; opens: number; lastStart: number | null }): void {
    if (options.opens === 0) {
      this.log(options.hasExistingIdentity ? 'reinstall' : 'install');
    }

    if (options.lastStart !== null) {
      const daysAway = (this.deps.clock.now() - options.lastStart) / (24 * 60 * 60_000);
      if (daysAway >= 7) this.log('reactivation');
    }

    this.log('app_open');

    // The leeway lets install and app_open leave in one request rather than
    // two, which is why iOS waits before the first flush.
    this.leewayTimer = setTimeout(() => void this.flush(), FIRST_BATCH_LEEWAY_MS);
    this.timer = setInterval(() => void this.flush(), BATCH_INTERVAL_MS);
  }

  log(event: SystemEventName, engagementTime?: number): void {
    if (!this.deps.isEnabled()) return;

    const queued: QueuedEvent = {
      id: randomUUID(),
      event,
      createdAt: this.deps.clock.now(),
      sessionId: this.deps.session.currentSessionId(),
    };
    const path = this.deps.currentPath();
    if (path) queued.path = path;
    if (typeof engagementTime === 'number') queued.engagementTime = engagementTime;

    this.deps.queue.add(queued);

    if (this.deps.queue.size() >= MAX_BATCH_SIZE) void this.flush();
  }

  /** Enqueues an already-built event, used by the custom events handler. */
  enqueue(event: QueuedEvent): void {
    if (!this.deps.isEnabled()) return;
    this.deps.queue.add(event);
    if (this.deps.queue.size() >= MAX_BATCH_SIZE) void this.flush();
  }

  /**
   * Called once the deep link payload resolves. Back-fills the path onto
   * everything queued before it was known, then unblocks sending.
   */
  onPathResolved(path: string | null): void {
    if (path) {
      this.deps.queue.transform((event) => (event.path ? event : { ...event, path }));
    }
    this.pathResolved = true;
  }

  async flush(): Promise<void> {
    if (!this.pathResolved || this.sending || !this.deps.isEnabled()) return;

    const pending = this.deps.queue.pruneStale();
    if (pending.length === 0) return;

    this.sending = true;
    try {
      // Drain rather than send one batch: a queue of 300 would otherwise take
      // five minutes to clear at one batch per 30-second tick.
      let remaining = pending;
      while (remaining.length > 0) {
        const sent = await this.sendChunks(remaining.slice(0, MAX_BATCH_SIZE), false);
        if (!sent) break;
        remaining = this.deps.queue.all();
      }
    } finally {
      this.sending = false;
    }
  }

  /**
   * The exit flush. System events go first and the batch fills to a byte
   * ceiling, so the failure mode is "some custom events arrive later" rather
   * than "the final time_spent vanishes" — and time_spent is not retryable,
   * because the session it measures is over.
   */
  flushOnExit(): void {
    if (!this.deps.isEnabled()) return;

    const pending = this.deps.queue.all();
    if (pending.length === 0) {
      this.deps.queue.flushToStorage();
      return;
    }

    const ordered = [
      ...pending.filter((event) => typeof event.event === 'string'),
      ...pending.filter((event) => typeof event.event !== 'string'),
    ];

    const batch: QueuedEvent[] = [];
    const bodies: unknown[] = [];
    let bytes = 0;

    for (const event of ordered.slice(0, MAX_BATCH_SIZE)) {
      const body = enrich(event);
      const size = JSON.stringify(body).length;
      if (bytes + size > KEEPALIVE_BUDGET_BYTES) break;
      bytes += size;
      batch.push(event);
      bodies.push(body);
    }

    if (bodies.length > 0) {
      // Remove only once the request resolves. Deleting up front loses the
      // batch outright whenever keepalive is refused — over budget, offline,
      // or a network error — and time_spent is not retryable from a later
      // page load if it was already dropped here.
      const ids = batch.map((event) => event.id);
      void this.deps.api
        .addEvents(bodies, true)
        .then((response) => {
          if (response.ok) this.deps.queue.remove(ids);
          this.deps.queue.flushToStorage();
        })
        .catch(() => {
          this.deps.queue.flushToStorage();
        });

      if (batch.length < ordered.length) {
        this.deps.logger.info(
          `Exit flush sent ${batch.length} of ${ordered.length} events; ` +
            'the remainder stays queued for the next page load.',
        );
      }
    }

    // Whatever did not fit must survive the unload.
    this.deps.queue.flushToStorage();
  }

  /** Restarts the flush interval after a setEnabled(false) / (true) cycle. */
  resume(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.flush(), BATCH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.leewayTimer !== null) clearTimeout(this.leewayTimer);
    this.timer = null;
    this.leewayTimer = null;
  }

  /** Returns whether the batch was accepted, so the caller knows to continue. */
  private async sendChunks(chunk: QueuedEvent[], keepalive: boolean): Promise<boolean> {
    const bodies = chunk.map((event) => enrich(event));
    const response = await this.deps.api.addEvents(bodies, keepalive);

    if (!response.ok) {
      // Transport failure: everything stays queued and retries next tick.
      this.deps.logger.reportError(
        GrovsError.eventDispatchFailed,
        `Event batch failed with status ${response.status}; ${chunk.length} events remain queued.`,
      );
      return false;
    }

    // Spec B6: HTTP 200 with per-event errors. Rejections are validation
    // failures — unknown event type, reserved event_name — and are permanent.
    // Retrying one is an infinite loop that also blocks every event behind it,
    // so rejected indices are dropped rather than retried.
    const result = response.body as Partial<BatchResult> | null;
    const rejectedIndices = new Set((result?.errors ?? []).map((error) => error.index));

    if (rejectedIndices.size > 0) {
      const detail = (result?.errors ?? [])
        .map((error) => `#${error.index}: ${error.error}`)
        .join('; ');
      this.deps.logger.reportError(
        GrovsError.eventDispatchFailed,
        `The backend rejected ${rejectedIndices.size} event(s) permanently — ${detail}. ` +
          'These are dropped, not retried.',
      );
    }

    // Both accepted and permanently-rejected events leave the queue. Indexing
    // is against the batch as sent, before any removal, so the arithmetic
    // cannot drift.
    this.deps.queue.remove(chunk.map((event) => event.id));
    return true;
  }
}
