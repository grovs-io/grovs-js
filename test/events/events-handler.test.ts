import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventsHandler, __resetPageAttribution } from '../../src/events/events-handler';
import { PersistedQueue } from '../../src/storage/persisted-queue';
import { SessionManager } from '../../src/core/session';
import { ApiService } from '../../src/net/api';
import { resolveConfig } from '../../src/core/config';
import { Context } from '../../src/core/context';
import { Logger } from '../../src/logging/logger';
import { GrovsError } from '../../src/net/errors';
import { FakeTransport } from '../helpers/fake-transport';
import type { TransportRequest, TransportResponse } from '../../src/net/transport';
import { FakeStorage } from '../helpers/fake-storage';
import { FakeClock } from '../helpers/fake-clock';

function harness(
  options: { path?: string | null; onError?: () => void; canTransmit?: () => boolean } = {},
) {
  const transport = new FakeTransport();
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const logger = new Logger();
  if (options.onError) logger.setOnError(options.onError);

  const api = new ApiService(
    resolveConfig({ apiKey: 'k' }),
    new Context(),
    transport,
    () => 'https://app.example.com',
  );
  const queue = new PersistedQueue(storage, clock);
  const session = new SessionManager(storage, clock);

  const handler = new EventsHandler({
    api,
    queue,
    session,
    clock,
    logger,
    currentPath: () => options.path ?? null,
    isEnabled: () => true,
    ...(options.canTransmit ? { canTransmit: options.canTransmit } : {}),
  });

  return { handler, transport, queue, clock, storage, session };
}

function batchBodies(transport: FakeTransport): Record<string, unknown>[] {
  const request = transport.requestsTo('/events/batch').slice(-1)[0];
  return (request?.body as { events: Record<string, unknown>[] }).events;
}

describe('EventsHandler system events', () => {
  beforeEach(() => vi.useRealTimers());

  it('logs install on a first-ever visit', () => {
    const { handler, queue } = harness();
    handler.start({ hasExistingIdentity: false, opens: 0, lastStart: null });
    handler.stop();
    expect(queue.all().map((e) => e.event)).toEqual(['install', 'app_open']);
  });

  // iOS decides this by whether a keychain identifier survived the uninstall.
  it('logs reinstall when an identifier already existed', () => {
    const { handler, queue } = harness();
    handler.start({ hasExistingIdentity: true, opens: 0, lastStart: null });
    handler.stop();
    expect(queue.all().map((e) => e.event)).toEqual(['reinstall', 'app_open']);
  });

  it('logs only app_open on a returning visit', () => {
    const { handler, queue } = harness();
    handler.start({ hasExistingIdentity: true, opens: 5, lastStart: null });
    handler.stop();
    expect(queue.all().map((e) => e.event)).toEqual(['app_open']);
  });

  it('logs reactivation after seven days away', () => {
    const { handler, queue, clock } = harness();
    const eightDaysAgo = clock.now() - 8 * 24 * 60 * 60_000;
    handler.start({ hasExistingIdentity: true, opens: 3, lastStart: eightDaysAgo });
    handler.stop();
    expect(queue.all().map((e) => e.event)).toEqual(['reactivation', 'app_open']);
  });

  it('does not log reactivation after six days', () => {
    const { handler, queue, clock } = harness();
    const sixDaysAgo = clock.now() - 6 * 24 * 60 * 60_000;
    handler.start({ hasExistingIdentity: true, opens: 3, lastStart: sixDaysAgo });
    handler.stop();
    expect(queue.all().map((e) => e.event)).toEqual(['app_open']);
  });

  it('stamps the session id and a stable event id on each event', () => {
    const { handler, queue, session } = harness();
    handler.log('view');
    handler.stop();

    const event = queue.all()[0];
    expect(event?.sessionId).toBe(session.currentSessionId());
    expect(event?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stamps the deep link path when one is known', () => {
    const { handler, queue } = harness({ path: 'abc123' });
    handler.log('view');
    handler.stop();
    expect(queue.all()[0]?.path).toBe('abc123');
  });
});

describe('EventsHandler flushing', () => {
  beforeEach(() => vi.useRealTimers());

  it('sends nothing until the deep link path resolves', async () => {
    const { handler, transport } = harness();
    handler.log('app_open');
    await handler.flush();
    expect(transport.requestsTo('/events/batch')).toHaveLength(0);

    handler.onPathResolved(null);
    await handler.flush();
    expect(transport.requestsTo('/events/batch')).toHaveLength(1);
    handler.stop();
  });

  it('back-fills the path onto already-queued events', async () => {
    const { handler, transport } = harness();
    handler.log('app_open');
    handler.onPathResolved('resolved-path');
    await handler.flush();
    expect(batchBodies(transport)[0]?.['path']).toBe('resolved-path');
    handler.stop();
  });

  it('removes events from the queue once accepted', async () => {
    const { handler, queue, transport } = harness();
    transport.enqueue({ ok: true, status: 200, body: { accepted: 1, rejected: 0, errors: [] } });
    handler.log('app_open');
    handler.onPathResolved(null);
    await handler.flush();
    expect(queue.size()).toBe(0);
    handler.stop();
  });

  it('keeps events queued when the transport fails', async () => {
    const onError = vi.fn();
    const { handler, queue, transport } = harness({ onError });
    transport.enqueueStatus(500, {});
    handler.log('app_open');
    handler.onPathResolved(null);
    await handler.flush();

    expect(queue.size()).toBe(1);
    expect(onError).toHaveBeenCalledWith(GrovsError.eventDispatchFailed, expect.any(String));
    handler.stop();
  });

  // Spec B6, the sharp one: a 200 with per-event errors. Rejected events are
  // permanently invalid, so retrying loops forever and blocks everything
  // behind them.
  it('drops rejected indices permanently and retries nothing', async () => {
    const onError = vi.fn();
    const { handler, queue, transport } = harness({ onError });

    transport.enqueue({
      ok: true,
      status: 200,
      body: {
        accepted: 48,
        rejected: 2,
        errors: [
          { index: 3, error: "unknown event type 'bogus'" },
          { index: 17, error: "event_name 'install' is reserved" },
        ],
      },
    });

    for (let i = 0; i < 50; i += 1) handler.log('view');
    handler.onPathResolved(null);
    await handler.flush();

    expect(queue.size()).toBe(0);
    expect(onError).toHaveBeenCalledWith(
      GrovsError.eventDispatchFailed,
      expect.stringContaining('#3'),
    );
    expect(onError).toHaveBeenCalledWith(
      GrovsError.eventDispatchFailed,
      expect.stringContaining('permanently'),
    );
    handler.stop();
  });

  it('chunks at 50 events per request and drains the rest', async () => {
    const { handler, transport, queue } = harness();
    for (let i = 0; i < 120; i += 1) handler.log('view');
    handler.onPathResolved(null);
    await handler.flush();

    const batches = transport.requestsTo('/events/batch');
    const sizes = batches.map(
      (r) => (r.body as { events: unknown[] }).events.length,
    );
    // A queue of 300 would otherwise take five minutes to clear at one batch
    // per 30-second tick.
    expect(sizes).toEqual([50, 50, 20]);
    expect(queue.size()).toBe(0);
    handler.stop();
  });

  it('stops draining when a batch fails, leaving the remainder queued', async () => {
    const { handler, transport, queue } = harness();
    transport
      .enqueue({ ok: true, status: 200, body: { accepted: 50, rejected: 0, errors: [] } })
      .enqueueStatus(500, {});

    for (let i = 0; i < 120; i += 1) handler.log('view');
    handler.onPathResolved(null);
    await handler.flush();

    expect(transport.requestsTo('/events/batch')).toHaveLength(2);
    expect(queue.size()).toBe(70);
    handler.stop();
  });

  it('flushes automatically once 50 events are queued', async () => {
    const { handler, transport } = harness();
    handler.onPathResolved(null);
    for (let i = 0; i < 50; i += 1) handler.log('view');
    await vi.waitFor(() => expect(transport.requestsTo('/events/batch').length).toBeGreaterThan(0));
    handler.stop();
  });

  it('does not overlap concurrent flushes', async () => {
    const { handler, transport } = harness();
    handler.log('app_open');
    handler.onPathResolved(null);

    await Promise.all([handler.flush(), handler.flush(), handler.flush()]);
    expect(transport.requestsTo('/events/batch')).toHaveLength(1);
    handler.stop();
  });
});

describe('EventsHandler malformed events', () => {
  beforeEach(() => vi.useRealTimers());

  // Belt and braces behind the storage-level guard: an unencodable event that
  // reaches the handler must be discarded, not allowed to block the batch.
  it('discards an unencodable event and sends the rest', async () => {
    const { handler, transport, queue } = harness();

    handler.enqueue({ id: 'poison', createdAt: 1, sessionId: 's', eventName: '' });
    handler.log('app_open');
    handler.onPathResolved(null);

    await expect(handler.flush()).resolves.toBeUndefined();

    const events = batchBodies(transport);
    expect(events).toHaveLength(1);
    expect(events[0]?.['event']).toBe('app_open');
    expect(queue.size()).toBe(0);
    handler.stop();
  });
});

describe('EventsHandler cadence', () => {
  it('waits the 5 second leeway before the first flush', async () => {
    vi.useFakeTimers();
    const { handler, transport } = harness();
    handler.onPathResolved(null);
    handler.start({ hasExistingIdentity: false, opens: 0, lastStart: null });

    expect(transport.requestsTo('/events/batch')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.requestsTo('/events/batch')).toHaveLength(1);

    // install and app_open leave together, which is the point of the leeway.
    expect(batchBodies(transport).map((b) => b['event'])).toEqual(['install', 'app_open']);

    handler.stop();
    vi.useRealTimers();
  });

  it('flushes every 30 seconds thereafter', async () => {
    vi.useFakeTimers();
    const { handler, transport } = harness();
    handler.onPathResolved(null);
    handler.start({ hasExistingIdentity: true, opens: 2, lastStart: null });

    await vi.advanceTimersByTimeAsync(5000);
    const afterLeeway = transport.requestsTo('/events/batch').length;

    handler.log('view');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.requestsTo('/events/batch').length).toBe(afterLeeway + 1);

    handler.stop();
    vi.useRealTimers();
  });

  it('stops the timers on stop', async () => {
    vi.useFakeTimers();
    const { handler, transport } = harness();
    handler.onPathResolved(null);
    handler.start({ hasExistingIdentity: true, opens: 2, lastStart: null });
    handler.stop();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.requestsTo('/events/batch')).toHaveLength(0);
    vi.useRealTimers();
  });
});

describe('EventsHandler exit flush', () => {
  beforeEach(() => vi.useRealTimers());

  it('sends with keepalive so the request survives unload', () => {
    const { handler, transport } = harness();
    handler.log('time_spent', 42);
    handler.flushOnExit();

    const request = transport.requestsTo('/events/batch').slice(-1)[0];
    expect(request?.keepalive).toBe(true);
    handler.stop();
  });

  // The unload path cannot wait for the 1s debounce, so whatever did not fit
  // in the keepalive budget has to be on disk before the page goes away.
  it('persists the surviving queue synchronously, without waiting for the debounce', () => {
    vi.useFakeTimers();
    const { handler, storage, clock, session } = harness();

    for (let i = 0; i < 10; i += 1) {
      handler.enqueue({
        id: `custom-${i}`,
        eventName: 'fat',
        createdAt: clock.now(),
        sessionId: session.currentSessionId(),
        properties: { blob: 'x'.repeat(8000) },
      });
    }

    // Nothing written yet: the debounce timer has not fired.
    expect(storage.get('grovs_events')).toBeNull();

    handler.flushOnExit();

    const persisted = JSON.parse(storage.get('grovs_events') ?? 'null') as unknown[];
    expect(Array.isArray(persisted)).toBe(true);
    expect(persisted.length).toBeGreaterThan(0);

    handler.stop();
    vi.useRealTimers();
  });

  it('writes nothing when there is nothing to persist', () => {
    const { handler, storage } = harness();
    handler.flushOnExit();
    expect(storage.get('grovs_events')).toBeNull();
    handler.stop();
  });

  // Spec T3: system events go first and the batch fills to a byte ceiling, so
  // the final time_spent is never the thing that gets dropped.
  it('prioritises system events over fat custom events within the byte budget', () => {
    const { handler, transport, clock, session } = harness();

    // Ten custom events at ~8 KB of properties each — 80 KB, past the 60 KB
    // keepalive ceiling.
    for (let i = 0; i < 10; i += 1) {
      handler.enqueue({
        id: `custom-${i}`,
        eventName: 'fat',
        createdAt: clock.now(),
        sessionId: session.currentSessionId(),
        properties: { blob: 'x'.repeat(8000) },
      });
    }
    handler.log('time_spent', 30);

    handler.flushOnExit();

    const bodies = batchBodies(transport);
    expect(bodies[0]?.['event']).toBe('time_spent');

    const bytes = JSON.stringify(bodies).length;
    expect(bytes).toBeLessThan(64 * 1024);
    expect(bodies.length).toBeLessThan(11);
    handler.stop();
  });

  it('leaves what did not fit queued for the next page load', () => {
    const { handler, queue, clock, session } = harness();
    for (let i = 0; i < 10; i += 1) {
      handler.enqueue({
        id: `custom-${i}`,
        eventName: 'fat',
        createdAt: clock.now(),
        sessionId: session.currentSessionId(),
        properties: { blob: 'x'.repeat(8000) },
      });
    }

    handler.flushOnExit();
    expect(queue.size()).toBeGreaterThan(0);
    handler.stop();
  });
});

/** Holds every response until released, so two flushes can genuinely overlap. */
class GatedTransport extends FakeTransport {
  private gate: Promise<void> = Promise.resolve();
  private open: (() => void) | null = null;

  block(): void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.open = null;
    this.gate = Promise.resolve();
  }

  override async send(request: TransportRequest): Promise<TransportResponse> {
    const response = await super.send(request);
    await this.gate;
    return response;
  }
}

function gatedHarness() {
  const transport = new GatedTransport();
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const queue = new PersistedQueue(storage, clock);
  const handler = new EventsHandler({
    api: new ApiService(resolveConfig({ apiKey: 'k' }), new Context(), transport, () => 'https://x'),
    queue,
    session: new SessionManager(storage, clock),
    clock,
    logger: new Logger(),
    currentPath: () => null,
    isEnabled: () => true,
  });
  return { handler, queue, clock, transport };
}

describe('transmission is gated on more than the enabled flag', () => {
  // reset() with consent revoked clears the queue and the identity but left
  // the handler holding its permission to send, so the next tracked event
  // reached the network after the user withdrew the permission for it.
  it('sends nothing while consent is withheld, and sends once it is granted', async () => {
    let allowed = false;
    const { handler, transport } = harness({ canTransmit: () => allowed });
    handler.onPathResolved(null);
    handler.log('app_open');

    await handler.flush();
    expect(transport.requestsTo('/events/batch')).toHaveLength(0);

    allowed = true;
    await handler.flush();
    expect(transport.requestsTo('/events/batch')).toHaveLength(1);
  });

  it('keeps the exit flush on the device too', () => {
    const { handler, transport, queue } = harness({ canTransmit: () => false });
    handler.log('app_open');

    handler.flushOnExit();

    expect(transport.requestsTo('/events/batch')).toHaveLength(0);
    expect(queue.size()).toBe(1);
  });
});

describe('flush() waits for delivery', () => {
  // Documented for integrators facing a hard navigation. A second caller used
  // to be told "busy" and get a resolved promise, so the page navigated away
  // with the batch still in flight.
  it('makes a concurrent caller await the drain in progress', async () => {
    const { handler, queue, transport } = gatedHarness();
    handler.onPathResolved(null);
    handler.log('app_open');

    transport.block();
    const first = handler.flush();
    const second = handler.flush();
    transport.release();

    await second;
    expect(queue.size()).toBe(0);
    await first;
  });

  it('drains again after the first drain finishes', async () => {
    const { handler, queue, transport } = gatedHarness();
    handler.onPathResolved(null);
    handler.log('app_open');
    await handler.flush();

    handler.log('time_spent', 5);
    await handler.flush();

    expect(queue.size()).toBe(0);
    expect(transport.requestsTo('/events/batch')).toHaveLength(2);
  });
});

describe('the exit flush and the drain can overlap', () => {
  // The reverse — skipping what the drain holds — loses the final time_spent
  // whenever navigation cancels that ordinary request, and it is the one event
  // that cannot be re-sent. A duplicate is the backend's dedup window to
  // absorb; this is the trade the module makes everywhere else.
  // A drain in flight either completes or is cancelled by the unload; a
  // cancelled batch stays queued for the next page load. Sending it again
  // from the exit path delivered it twice whenever a hide overlapped a tick.
  it('does not send events an ordinary drain already holds', async () => {
    const { handler, transport, queue } = gatedHarness();
    handler.onPathResolved(null);
    handler.log('time_spent', 12);

    transport.block();
    const drain = handler.flush();
    handler.flushOnExit();

    expect(transport.requestsTo('/events/batch')).toHaveLength(1);
    transport.release();
    await drain;
    expect(queue.size()).toBe(0);
  });

  it('await flush() waits for a keepalive request still in flight', async () => {
    const { handler, transport, queue } = gatedHarness();
    handler.onPathResolved(null);
    handler.log('time_spent', 12);

    transport.block();
    handler.flushOnExit();
    let settled = false;
    const flushed = handler.flush().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    transport.release();
    await flushed;
    expect(queue.size()).toBe(0);
  });

  it('reports per-event rejections from the keepalive path too', () => {
    const onError = vi.fn();
    const { handler, transport } = harness({ onError });
    handler.onPathResolved(null);
    handler.log('time_spent', 12);
    transport.enqueue({
      ok: true,
      status: 200,
      body: { accepted: 0, rejected: 1, errors: [{ index: 0, error: 'bad' }] },
    });
    handler.flushOnExit();
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      expect(onError).toHaveBeenCalledWith(GrovsError.eventDispatchFailed, expect.stringContaining('bad'));
    });
  });
});

describe('the path back-fill belongs to this visit', () => {
  // The queue survives reloads for seven days. Back-filling everything stamped
  // today's campaign onto a direct visit from a previous day.
  it('stamps this session and leaves an earlier session alone', () => {
    const { handler, queue, clock } = harness();

    queue.add({
      id: 'yesterday',
      event: 'app_open',
      createdAt: clock.now() - 24 * 60 * 60_000,
      sessionId: 'old-session',
    });
    handler.log('app_open');

    handler.onPathResolved('campaign-a');

    const byId = new Map(queue.all().map((event) => [event.id, event]));
    expect(byId.get('yesterday')?.path).toBeUndefined();
    expect(queue.all().filter((event) => event.path === 'campaign-a')).toHaveLength(1);
  });

  // The boundary is the page, not the handler. A second configure() builds a
  // replacement whose queue is restored from the store the previous client
  // wrote — those events are older than this handler and still this page's,
  // so they take this page's attribution.
  it('stamps an event an earlier client on this page queued', () => {
    const { handler, queue } = harness();

    // Queued through the handler, as the earlier client would have done, and
    // before any attribution was known.
    handler.log('app_open');
    expect(queue.all()[0]?.pathFinal).toBeUndefined();

    handler.onPathResolved('campaign-a');

    expect(queue.all()[0]?.path).toBe('campaign-a');
  });

  // A sibling tab shares the storage and the session, so it can hold an
  // unsettled event of ours. It must not attribute it: both tabs would send
  // the same event_id with different bodies, and the backend's hash covers
  // the resolved link, so they land as two events under two campaigns.
  it('leaves an event another tab queued for that tab to attribute', () => {
    const direct = harness();
    direct.handler.log('app_open');
    const theirEvent = direct.queue.all()[0];
    expect(theirEvent).toBeDefined();

    // The campaign tab is its own page load, so its own bookkeeping. One
    // module instance cannot hold two of those, so resetting here is what
    // "a second tab" means in a unit test.
    __resetPageAttribution();
    const campaign = harness();
    campaign.queue.add({ ...theirEvent! });
    campaign.handler.onPathResolved('campaign-a');

    // Untouched, and still unsettled: the tab that created it will settle it,
    // and until then no copy of it can be sent with a campaign it never had.
    expect(campaign.queue.all()[0]?.path).toBeUndefined();
    expect(campaign.queue.all()[0]?.pathFinal).toBeUndefined();
  });
});

describe('the exit flush measures the request the browser measures', () => {
  // String.length counts UTF-16 code units. Ten events of Chinese text passed
  // a 60 KB check at 40 KB by that measure and left as a 79 KB keepalive
  // request, which the browser rejects outright — taking the prioritized
  // system events down with the custom ones.
  it('keeps a batch of non-ASCII properties inside the keepalive budget', () => {
    const { handler, queue, clock, transport } = harness();
    handler.onPathResolved(null);

    for (let i = 0; i < 20; i += 1) {
      queue.add({
        id: `e${i}`,
        eventName: 'purchase',
        createdAt: clock.now(),
        sessionId: 's',
        properties: { note: '订单已确认'.repeat(400) },
      });
    }

    handler.flushOnExit();

    const request = transport.requestsTo('/events/batch')[0];
    const bytes = new TextEncoder().encode(JSON.stringify(request?.body)).length;
    expect(bytes).toBeLessThanOrEqual(60 * 1024);
    // ...and it still sent what did fit, rather than giving up on the batch.
    expect((request?.body as { events: unknown[] }).events.length).toBeGreaterThan(0);
    expect(queue.size()).toBe(20);
  });
});
