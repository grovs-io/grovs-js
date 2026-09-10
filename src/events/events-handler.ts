import type { SystemEventName } from '../contract/event-contract';
import type { Clock } from '../core/clock';
import type { SessionManager } from '../core/session';
import { randomUUID } from '../core/uuid';
import type { Logger } from '../logging/logger';
import type { ApiService, BatchResult } from '../net/api';
import type { TransportResponse } from '../net/transport';
import { GrovsError } from '../net/errors';
import type { PersistedQueue } from '../storage/persisted-queue';
import { enrich, normaliseTags } from './enrich';
import { isSystemEvent, type QueuedEvent } from './event';
import { ENRICHMENT_LIMITS } from '../contract/event-contract';
import { byteLength } from '../core/bytes';

/**
 * Cadence is iOS's, not an implementer's choice. These two numbers determine
 * everything observable about the SDK's network behaviour, which makes them
 * parity constants rather than tuning details.
 */
/**
 * Web cadence, deliberately not iOS's 30 s (CustomEventsHandler.swift:45).
 *
 * A mobile session is minutes; a web visit is often seconds, and a batch that
 * has not left within the visit depends on the exit flush surviving a
 * termination the browser does not have to warn us about. Five seconds is
 * where the comparable web SDKs sit — Mixpanel batches on exactly this, and
 * Amplitude on one second. The cost is more requests on a page that produces
 * events steadily; the cap of 50 per batch bounds it, and an idle page still
 * sends nothing because a tick with an empty queue returns without a request.
 */
const BATCH_INTERVAL_MS = 5_000;
/** The launch events leave when attribution settles — see onPathResolved.
 *  This is only the backstop for a payload lookup that never answers. */
const FIRST_BATCH_LEEWAY_MS = 5_000; // EventsHandler.swift:18

/** Matches the batch cap the backend enforces on its events endpoint. */
const MAX_BATCH_SIZE = 50;

/**
 * Ids this page load queued before its attribution was known.
 *
 * Page-scoped, not per handler: a consent grant replaces the client, and the
 * events the pending one queued are still this page's to attribute. And not
 * wider than the page either — a sibling tab shares the storage and the
 * session, so it could adopt an unsettled event of ours from the queue and
 * stamp its own campaign on it. Both tabs then send the same event_id with
 * different bodies, and the backend's hash covers the resolved link, so they
 * land as two events under two campaigns. An event is only ever attributed
 * by the page that created it.
 */
const queuedBeforeAttribution = new Set<string>();

/** The queue's own cap. An id whose event the queue has already evicted can
 *  never be stamped, so holding it is pure growth — and consent can stay
 *  pending for a whole visit. Insertion-ordered, so this drops oldest first. */
const MAX_PENDING_ATTRIBUTION = 1000;

function rememberForAttribution(id: string): void {
  queuedBeforeAttribution.add(id);
  for (const oldest of queuedBeforeAttribution) {
    if (queuedBeforeAttribution.size <= MAX_PENDING_ATTRIBUTION) break;
    queuedBeforeAttribution.delete(oldest);
  }
}

/** Test seam: the set is module-private, and its bound needs asserting. */
export function __pendingAttributionSize(): number {
  return queuedBeforeAttribution.size;
}

/** Test seam: page-scoped, so it would otherwise leak between tests. */
export function __resetPageAttribution(): void {
  queuedBeforeAttribution.clear();
}

/**
 * Browsers cap all in-flight keepalive bodies at 64 KB combined and reject
 * rather than truncate past it. A 50-event batch of custom events carrying the
 * permitted 8 KB of properties is 400 KB, so the exit flush measures.
 */
// Well under it: the quota is per process and shared with the host page's
// own sendBeacon calls, which fail outright while ours fills it.
const KEEPALIVE_BUDGET_BYTES = 32 * 1024;

/** `{"events":[]}` — the wrapper counts against the same cap the bodies do. */
const KEEPALIVE_ENVELOPE_BYTES = 13;

export interface EventsHandlerDeps {
  api: ApiService;
  queue: PersistedQueue;
  session: SessionManager;
  clock: Clock;
  logger: Logger;
  /** The deep link path to stamp on events, once resolved. */
  currentPath: () => string | null;
  isEnabled: () => boolean;
  /** False once the owning client is retired. Freezing the queue stops a late
   *  write; this stops the loop issuing further requests after retirement. */
  isActive?: () => boolean;
  /** False while consent is pending or withdrawn, and before authentication.
   *  Gates transmission only: consent mode keeps queueing what it cannot send. */
  canTransmit?: () => boolean;
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
  /** The drain in progress. Concurrent callers await it rather than being
   *  told the queue is busy — see flush(). */
  private draining: Promise<void> | null = null;
  /** Set once the payload lookup resolves, so events are not sent before their
   *  attribution path is known. Mirrors hasFetchedPayloadLink on iOS. */
  private pathResolved = false;
  /**
   * After a failed drain, size-triggered flushes wait for the next interval
   * tick. Without this a full queue against a failing backend sends one
   * request per tracked event — an outage amplified by every page running
   * the SDK.
   */
  private retryAfter = 0;
  /**
   * A deadline the server named, kept apart from the backoff above.
   *
   * They clear differently: our backoff means "that batch failed, wait a
   * tick", so any success retires it. A Retry-After means "this backend is
   * shedding load", which another request completing says nothing about — and
   * an ordinary batch and a keepalive batch are in flight at the same time
   * every time a page is hidden mid-drain, so the two answers arrive in
   * either order.
   */
  private serverCooldownUntil = 0;
  /**
   * Ids in a keepalive request not yet answered. A keepalive request
   * survives the unload that follows a hide, so the pagehide flush and the
   * normal drain must not send those events again — that was the double
   * count the exit path used to accept.
   */
  private readonly inFlightKeepalive = new Set<string>();
  /** Owned here, not by the custom handler: the README promises global tags
   *  on every event, and time_spent is an event. */
  private globalTags: string[] | null = null;
  /** Ids in the ordinary drain's request. The hide flush skips them: that
   *  request either completes or is cancelled by the unload, and either way
   *  the events are not lost — a cancelled one re-sends on the next load. */
  private readonly inFlightDrain = new Set<string>();
  /** Settles when every keepalive request so far has been answered, so
   *  `await flush()` means delivered. */
  private keepaliveSettled: Promise<void> = Promise.resolve();
  constructor(private readonly deps: EventsHandlerDeps) {}

  setGlobalTags(tags: string[] | null): void {
    const normalised = normaliseTags(tags ?? undefined);
    this.globalTags = normalised ?? null;
  }

  /**
   * Per-event tags take priority: when the combined count exceeds the cap,
   * they are kept first and global tags fill what remains. The alternative —
   * global tags crowding out the ones describing this specific event — loses
   * the more informative half.
   */
  mergeTags(tags?: string[]): string[] | undefined {
    // Bounded before queueing, not only at send: a stored event otherwise
    // carries whatever the caller passed, against the queue's byte budget.
    const perEvent = normaliseTags(tags) ?? [];
    const global = this.globalTags ?? [];
    if (perEvent.length === 0 && global.length === 0) return undefined;

    const merged = [...perEvent];
    for (const tag of global) {
      if (merged.length >= ENRICHMENT_LIMITS.maxTags) break;
      if (!merged.includes(tag)) merged.push(tag);
    }
    return merged.slice(0, ENRICHMENT_LIMITS.maxTags);
  }

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
    this.startTimers();
  }

  /** The flush schedule without the launch events, for a replacement client
   *  taking over a visit that has already emitted them. */
  startTimers(): void {
    if (this.timer !== null) return;
    // The leeway lets install and app_open leave in one request rather than
    // two, which is why iOS waits before the first flush.
    this.leewayTimer = setTimeout(() => this.tick(), FIRST_BATCH_LEEWAY_MS);
    this.timer = setInterval(() => this.tick(), BATCH_INTERVAL_MS);
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
    const tags = this.mergeTags();
    if (tags) queued.tags = tags;
    // Attribution is already settled, so this event is born immutable — see
    // onPathResolved. Without it a replay could gain a later campaign's path.
    if (this.pathResolved) queued.pathFinal = true;
    else rememberForAttribution(queued.id);

    this.deps.queue.add(queued);
    // time_spent is logged from the hide and exit handlers; a size flush
    // there would start an ordinary request the unload cancels, and the
    // keepalive that follows would skip the events it holds.
    if (event !== 'time_spent') this.flushIfFull();
  }

  /** Enqueues an already-built event, used by the custom events handler. */
  enqueue(event: QueuedEvent): void {
    if (!this.deps.isEnabled()) return;
    if (this.pathResolved) event.pathFinal = true;
    else rememberForAttribution(event.id);
    this.deps.queue.add(event);
    this.flushIfFull();
  }

  private flushIfFull(): void {
    // What is *sendable*, not what is queued. A keepalive request holds up to
    // 50 events until it is answered, and counting those kept the queue over
    // the threshold, so every further track() started a request of its own —
    // the amplification the cooldown exists to prevent, on the one path it
    // did not cover.
    const inFlight = this.inFlightKeepalive.size + this.inFlightDrain.size;
    if (this.deps.queue.size() - inFlight < MAX_BATCH_SIZE) return;
    if (this.deps.clock.now() < this.cooldownUntil()) return;
    // The automatic path: a queue reaching the batch size is the SDK's own
    // schedule, not the integrator asking, so it yields to a cooldown.
    void this.startDrain(true);
  }

  /**
   * Called once the deep link payload resolves. Back-fills the path onto the
   * events queued before it was known, and marks every queued event's
   * attribution settled, which is also what unblocks sending.
   *
   * An event is immutable from the moment it could have been transmitted.
   * The queue survives reloads, so an event already marked settled was
   * sendable on an earlier page load and may be in the backend already — and
   * the backend's event_id is a content hash folding in the resolved link, so
   * adding a path to a replay would make it a *different* event there and
   * count it twice under the new campaign. At-least-once delivery works only
   * because a re-send is byte-identical. "No campaign" is a settled answer
   * too, which is why the flag exists rather than reading an absent path.
   *
   * Stamping is still scoped to this session: the queue holds seven days, and
   * an unsettled event from yesterday's visit is not this campaign's.
   */
  onPathResolved(path: string | null): void {
    const session = this.deps.session.currentSessionId();
    this.deps.queue.transform((event) => {
      if (event.pathFinal) return event;
      // Ours to attribute only if this page queued it. A sibling tab's
      // unsettled event stays unsettled here; its own page will settle it.
      if (!queuedBeforeAttribution.has(event.id)) return event;
      const stamp = path && !event.path && event.sessionId === session;
      return stamp ? { ...event, path, pathFinal: true } : { ...event, pathFinal: true };
    });
    queuedBeforeAttribution.clear();
    this.pathResolved = true;

    // The first visit's events go now, not on the next tick. install,
    // app_open and the opening screen view are all queued by this point, and
    // every flush before this one returned without sending because
    // attribution was not settled — so without this the opening batch waited
    // out a whole interval, and a visit shorter than that depended on the
    // exit flush surviving the tab closing.
    if (this.deps.queue.size() > 0) this.tick();
  }

  /** Withdraws the permission to send that configure() granted. */
  resetDelivery(): void {
    this.pathResolved = false;
    queuedBeforeAttribution.clear();
  }

  private active(): boolean {
    return (
      this.deps.isEnabled() &&
      (this.deps.isActive?.() ?? true) &&
      (this.deps.canTransmit?.() ?? true)
    );
  }

  /** Drains the queue, returning when it has drained. Concurrent callers await
   *  the same drain — `await Grovs.flush()` is documented as waiting for
   *  delivery, including when the interval tick got there first. */
  flush(): Promise<void> {
    // The integrator asking directly: a drain started here goes through a
    // cooldown, which is the documented meaning of "drain the queue now".
    //
    // One exception, documented in the README rather than fixed: a drain
    // already running is joined rather than doubled, and if that one is a
    // scheduled drain that then yields to a throttled backend, this call
    // resolves with events still queued. Continuing here instead re-sends a
    // batch that has merely *failed*, doubling requests against a backend
    // already in trouble — a worse trade than a flush that returns early.
    return this.startDrain(false);
  }

  private startDrain(automatic: boolean): Promise<void> {
    // Every keepalive outstanding when this call was made, not only the ones
    // a drain already in progress knew about.
    const settled = this.keepaliveSettled;
    // A drain already running is awaited rather than doubled. If that one was
    // automatic and stops on a cooldown, this caller gets a partly drained
    // queue — the same as when a batch fails, and the next tick continues it.
    if (this.draining) return this.draining.then(() => settled);
    if (!this.pathResolved || !this.active()) return settled;

    const drain = this.drain(automatic).finally(() => {
      this.draining = null;
    });
    this.draining = drain;
    return drain.then(() => this.keepaliveSettled);
  }

  private async drain(automatic: boolean): Promise<void> {
    const pending = this.notInFlight(this.deps.queue.pruneStale());
    if (pending.length === 0) return;

    // Drain rather than send one batch: a queue of 300 would otherwise take
    // five minutes to clear at one batch per 30-second tick.
    let remaining = pending;
    while (remaining.length > 0) {
      // Checked before every batch, this one included. A concurrent keepalive
      // request can be answered with a 429 while this loop is awaiting, and
      // the batches behind it owe the server the same delay. Only a scheduled
      // drain yields — an explicit flush() is the integrator asking, and the
      // documented meaning of that is to drain the queue now.
      if (automatic && this.deps.clock.now() < this.cooldownUntil()) break;
      const sent = await this.sendChunks(remaining.slice(0, MAX_BATCH_SIZE), false);
      if (!sent) {
        // Never shorten a delay the server named: settleBatch may already
        // have set a longer one from Retry-After, and this is the floor.
        this.retryAfter = Math.max(
          this.retryAfter,
          this.deps.clock.now() + BATCH_INTERVAL_MS,
        );
        break;
      }
      // Re-check after the await: a client retired or disabled mid-drain
      // would otherwise keep transmitting the batches behind the one in
      // flight, and report their failures against a config that is gone.
      // pathResolved too, because a reset withdraws it — otherwise this loop
      // walks straight on into the *new* visitor's queue and sends their
      // events before their attribution has resolved.
      if (!this.active() || !this.pathResolved) break;
      remaining = this.notInFlight(this.deps.queue.all());
    }
  }

  private notInFlight(events: QueuedEvent[]): QueuedEvent[] {
    return events.filter((event) => !this.inFlightKeepalive.has(event.id));
  }

  /**
   * The keepalive flush, sent when the page is hidden.
   *
   * System events go first and the batch fills to a byte ceiling, so the
   * failure mode is "some custom events arrive later" rather than "the final
   * time_spent vanishes" — and time_spent is not retryable, because the
   * session it measures is over.
   *
   * Sent from the hidden transition. On an unload pagehide fires first and
   * the hide follows in every engine, and Firefox discards requests issued
   * from pagehide — so the hide is both the universal and the safe moment.
   * keepalive lets the request outlive the unload; if the tab merely went to
   * the background, it is answered normally and the events are removed.
   */
  flushOnExit(): void {
    if (!this.deps.isEnabled()) return;

    // Consent pending or withdrawn: the queue still reaches whichever store
    // consent allows, but nothing leaves the device.
    if (!(this.deps.canTransmit?.() ?? true)) {
      this.deps.queue.flushToStorage();
      return;
    }

    // Filtered by both kinds of request in flight. A keepalive one is not
    // cancelled by the unload, so a second hide has nothing left to send; an
    // ordinary one either completes or is cancelled, and a cancelled batch
    // stays queued for the next page load. Sending either again is the
    // double count this path used to accept.
    const pending = this.notInFlight(this.deps.queue.all()).filter(
      (event) => !this.inFlightDrain.has(event.id),
    );
    if (pending.length === 0) {
      this.deps.queue.flushToStorage();
      return;
    }

    const ordered = [
      ...pending.filter(isSystemEvent),
      ...pending.filter((event) => !isSystemEvent(event)),
    ];

    const batch: QueuedEvent[] = [];
    const bodies: unknown[] = [];
    // UTF-8 bytes of the whole request, as the browser measures it —
    // String.length counts UTF-16 code units and undercounts CJK threefold.
    let bytes = KEEPALIVE_ENVELOPE_BYTES;

    for (const event of ordered.slice(0, MAX_BATCH_SIZE)) {
      let body: unknown;
      try {
        body = enrich(event);
      } catch {
        continue;
      }
      const size = byteLength(JSON.stringify(body)) + (bodies.length > 0 ? 1 : 0);
      if (bytes + size > KEEPALIVE_BUDGET_BYTES) break;
      bytes += size;
      batch.push(event);
      bodies.push(body);
    }

    if (bodies.length > 0) {
      // Attribution may still be resolving: authentication is enough to
      // transmit, and a visitor can leave before the payload lookup answers.
      // Whatever leaves now is settled first and written before the request,
      // or the next page load would back-fill a later campaign onto it and
      // change the body under an id the backend has already seen.
      const settling = new Set(batch.map((event) => event.id));
      if (batch.some((event) => !event.pathFinal)) {
        this.deps.queue.transform((event) =>
          event.pathFinal || !settling.has(event.id) ? event : { ...event, pathFinal: true },
        );
        this.deps.queue.flushToStorage();
      }

      // Removed only once acknowledged, and persisted meanwhile. When the
      // page is gone before the answer, the next page load sends the batch
      // again; the backend's events table is a ReplacingMergeTree keyed on a
      // content-hash event_id, so the copy collapses. Losing the batch — the
      // alternative, and for a short visit the install itself — does not.
      const ids = batch.map((event) => event.id);
      for (const id of ids) this.inFlightKeepalive.add(id);
      const request = this.deps.api
        .addEvents(bodies, true)
        .then((response) => {
          this.settleBatch(response, batch);
        })
        .catch(() => {})
        .then(() => {
          for (const id of ids) this.inFlightKeepalive.delete(id);
          this.deps.queue.flushToStorage();
        });
      this.keepaliveSettled = this.keepaliveSettled.then(() => request);

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
    this.timer = setInterval(() => this.tick(), BATCH_INTERVAL_MS);
  }

  /**
   * The scheduled drain. Unlike an explicit Grovs.flush(), which is the
   * integrator deliberately asking, this one honours a backoff the server
   * asked for — otherwise a 429 naming two minutes still got a request from
   * every tab every thirty seconds, which is the outage amplification the
   * header exists to prevent.
   */
  /** A reconnect drain. Subject to a cooldown, unlike an explicit flush()
   *  where the integrator is asking directly. */
  flushIfDue(): void {
    this.tick();
  }

  /** The later of our own backoff and any deadline the server named. */
  private cooldownUntil(): number {
    return Math.max(this.retryAfter, this.serverCooldownUntil);
  }

  private tick(): void {
    if (this.deps.clock.now() < this.cooldownUntil()) return;
    if (this.deps.queue.size() === 0) return;
    void this.startDrain(true);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.leewayTimer !== null) clearTimeout(this.leewayTimer);
    this.timer = null;
    this.leewayTimer = null;
  }

  /** Returns whether the batch was accepted, so the caller knows to continue. */
  private async sendChunks(chunk: QueuedEvent[], keepalive: boolean): Promise<boolean> {
    const { bodies, sendable, malformed } = this.encode(chunk);

    // Drop anything unencodable rather than letting it block the queue.
    if (malformed.length > 0) {
      this.deps.queue.remove(malformed);
      this.deps.logger.warn(`Discarded ${malformed.length} malformed queued event(s).`);
    }
    if (bodies.length === 0) return true;
    for (const event of sendable) this.inFlightDrain.add(event.id);
    let response;
    try {
      response = await this.deps.api.addEvents(bodies, keepalive);
    } finally {
      for (const event of sendable) this.inFlightDrain.delete(event.id);
    }
    return this.settleBatch(response, sendable);
  }

  /**
   * One response handler for both delivery paths: a transport failure keeps
   * the batch queued, a success removes it, and per-event rejections are
   * reported — the keepalive path used to drop those silently.
   */
  private settleBatch(response: TransportResponse, sendable: QueuedEvent[]): boolean {
    if (response.ok) {
      // Cleared on success, or one failure would hold size-triggered flushes
      // back for a whole interval after the backend recovered.
      this.retryAfter = 0;
    } else if (response.retryAfterMs) {
      // The server named a delay; hold off at least that long.
      this.serverCooldownUntil = Math.max(
        this.serverCooldownUntil,
        this.deps.clock.now() + response.retryAfterMs,
      );
    }
    if (!response.ok) {
      // A retired client's failure is not the active one's failure.
      if (!this.active()) return false;
      // Transport failure: everything stays queued and retries next tick.
      this.deps.logger.reportError(
        GrovsError.eventDispatchFailed,
        `Event batch failed with status ${response.status}; ${sendable.length} events remain queued.`,
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
    this.deps.queue.remove(sendable.map((event) => event.id));
    return true;
  }

  /** Encodes what it can and reports what it cannot, so one bad record
   *  cannot stop the batch it happens to sit in. */
  private encode(chunk: QueuedEvent[]): {
    bodies: unknown[];
    sendable: QueuedEvent[];
    malformed: string[];
  } {
    const bodies: unknown[] = [];
    const sendable: QueuedEvent[] = [];
    const malformed: string[] = [];

    for (const event of chunk) {
      try {
        bodies.push(enrich(event));
        sendable.push(event);
      } catch {
        malformed.push(event.id);
      }
    }

    return { bodies, sendable, malformed };
  }
}
