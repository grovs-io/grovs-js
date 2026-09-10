import { describe, expect, it, vi } from 'vitest';
import { GrovsClient } from '../src/core/client';
import { PersistedQueue, QUEUE_STORAGE_KEY } from '../src/storage/persisted-queue';
import { LinkGenerator } from '../src/links/links';
import { PaymentEventsHandler } from '../src/events/payment-events-handler';
import { MessagesService } from '../src/messages/messages';
import { MessagesUI } from '../src/messages/messages-ui';
import { FetchTransport } from '../src/net/fetch-transport';
import { Logger } from '../src/logging/logger';
import { GrovsError } from '../src/net/errors';
import type { QueuedEvent } from '../src/events/event';
import type { Transport, TransportRequest, TransportResponse } from '../src/net/transport';
import { FakeTransport } from './helpers/fake-transport';
import { FakeStorage } from './helpers/fake-storage';
import { FakeClock } from './helpers/fake-clock';
import { SessionManager } from '../src/core/session';
import { DeeplinkResolver, STORED_PATH_KEY } from '../src/links/deeplink';
import { scopedKey } from '../src/storage/scoped-storage';
import { __pendingAttributionSize as pendingAttributionSize } from '../src/events/events-handler';
import { ScreenAliases } from '../src/tracking/screen-aliases';

/**
 * Each invariant here is one this SDK enforces in more than one place, and
 * each was at some point enforced in only one of them. A test per call site,
 * not per invariant: the second site is the one that goes quiet.
 */

const AUTH_OK = { ok: true, status: 200, body: { linksquared: 'v1' } };
const PAYLOAD_NONE = { ok: true, status: 200, body: { data: null } };

function make(overrides: Record<string, unknown> = {}, storage = new FakeStorage()) {
  const transport = new FakeTransport();
  const client = new GrovsClient(
    { apiKey: 'k', ...overrides },
    { transport, storage, autoStartEvents: false },
  );
  return { client, transport, storage };
}

async function authed(overrides: Record<string, unknown> = {}, storage = new FakeStorage()) {
  const made = make(overrides, storage);
  made.transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
  await made.client.configure();
  made.client.eventsHandler.onPathResolved(null);
  return made;
}

function stored(storage: FakeStorage): QueuedEvent[] {
  return JSON.parse(storage.get(QUEUE_STORAGE_KEY) ?? '[]') as QueuedEvent[];
}

describe('a tombstone means delivered, and only this tab can say so', () => {
  function fill(queue: PersistedQueue, prefix: string, count: number, from: number) {
    for (let i = 0; i < count; i += 1) {
      queue.add({ id: `${prefix}${i}`, eventName: 'e', createdAt: from + i, sessionId: 's' });
    }
  }

  // Adopting a sibling's events and then dropping them for the count cap used
  // to tombstone them, and a tombstone is a permanent suppression applied on
  // every later write — so the sibling's events were stripped from the shared
  // store for good. The eviction itself is invisible in storage, because the
  // cap re-trims either way; what distinguishes the bug is whether those ids
  // can ever come back once there is room for them.
  it('adopting a sibling\'s queue never suppresses the sibling\'s events', () => {
    const storage = new FakeStorage();
    const clock = new FakeClock();

    const theirs: QueuedEvent[] = Array.from({ length: 700 }, (_, i) => ({
      id: `theirs${i}`,
      eventName: 'e',
      createdAt: clock.now() + i,
      sessionId: 's',
    }));
    storage.set(QUEUE_STORAGE_KEY, JSON.stringify(theirs));

    const mine = new PersistedQueue(new FakeStorage(), clock);
    fill(mine, 'mine', 400, clock.now() + 100_000);
    // Consent granted: this tab repoints at the shared store and merges. 1,100
    // events against a 1,000 cap, so 100 of the sibling's oldest are dropped.
    (mine as unknown as { storage: FakeStorage }).storage = storage;
    mine.mergeFromStorage();
    expect(mine.size()).toBe(1000);

    // This tab delivers everything it holds, so the cap is no longer binding,
    // and the sibling — still open — writes its own queue again.
    mine.clear();
    storage.set(QUEUE_STORAGE_KEY, JSON.stringify(theirs));
    mine.add({ id: 'mine-new', eventName: 'e', createdAt: clock.now() + 200_000, sessionId: 's' });
    mine.flushToStorage();

    // Every one of the sibling's events is still there. Tombstoning the
    // evicted ones would have deleted 100 of them permanently.
    const ids = new Set(stored(storage).map((event) => event.id));
    for (const event of theirs) expect(ids.has(event.id)).toBe(true);
  });

  it('still suppresses events this tab actually delivered', () => {
    const storage = new FakeStorage();
    const queue = new PersistedQueue(storage, new FakeClock());
    queue.add({ id: 'sent', eventName: 'e', createdAt: 1, sessionId: 's' });
    queue.remove(['sent']);
    storage.set(QUEUE_STORAGE_KEY, JSON.stringify([{ id: 'sent', eventName: 'e', createdAt: 1, sessionId: 's' }]));
    queue.mergeFromStorage();
    expect(queue.all().map((event) => event.id)).not.toContain('sent');
  });
});

describe('an event is immutable from the moment it can be sent', () => {
  it('marks events minted after attribution settles, on both mint paths', async () => {
    const { client, storage } = await authed();
    client.track('custom_after');
    client.eventsHandler.log('time_spent', 5);
    client.shutdown();

    const events = stored(storage);
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.pathFinal).toBe(true);
  });

  it('a later campaign cannot re-attribute an event a previous page could have sent', async () => {
    const storage = new FakeStorage();
    const first = await authed({}, storage);
    first.client.track('checkout');
    first.client.shutdown();

    // Next page load, same session, arriving on a campaign link.
    const second = make({}, storage);
    second.client.eventsHandler.onPathResolved('promo-campaign');
    second.client.shutdown();

    const checkout = stored(storage).find((event) => event.eventName === 'checkout');
    expect(checkout?.path).toBeUndefined();
  });
});

describe('the transport never throws, whatever the caller passes', () => {
  it('reports an unserializable body as a failed request', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const response = await new FetchTransport().send({
      method: 'POST',
      url: 'https://example.invalid/x',
      headers: {},
      body: cyclic,
    });
    expect(response).toEqual({ ok: false, status: 0, body: null });
  });
});

describe('a rejected background push does not kill the ones behind it', () => {
  it('keeps syncing aliases after a rejection', async () => {
    const { client, transport } = await authed();
    transport.send = () => Promise.reject(new Error('boom'));
    client.setScreenAliases({ '/a': 'A' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sent: unknown[] = [];
    transport.send = (request) => {
      sent.push(request);
      return Promise.resolve({ ok: true, status: 200, body: {} });
    };
    client.setScreenAliases({ '/b': 'B' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
    client.dispose();
  });
});

describe('the reconnect flush survives the authentication retry path', () => {
  it('still flushes on `online` after a failed authentication recovered', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      transport.enqueueStatus(503).enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
      const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });
      await client.configure();

      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(100);
      expect(client.isAuthenticated()).toBe(true);

      client.eventsHandler.onPathResolved(null);
      client.track('after_recovery');
      const before = transport.requestsTo('/events/batch').length;
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(100);
      expect(transport.requestsTo('/events/batch').length).toBeGreaterThan(before);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a purchase is billed once', () => {
  it('carries a transaction id, and the same one on a retry', async () => {
    const { client, transport } = await authed();
    transport.fallback = { ok: true, status: 200, body: {} };
    await new PaymentEventsHandler(client).logCustomPurchase({
      type: 'buy',
      priceInCents: 1999,
      currency: 'USD',
      productID: 'sku-1',
    });
    const body = transport.requestsTo('/add_payment_event')[0]?.body as Record<string, unknown>;
    expect(typeof body['transaction_id']).toBe('string');
    expect(String(body['transaction_id'])).not.toHaveLength(0);
    client.dispose();
  });

  it('uses the caller\'s identifier when given one', async () => {
    const { client, transport } = await authed();
    transport.fallback = { ok: true, status: 200, body: {} };
    await new PaymentEventsHandler(client).logCustomPurchase({
      type: 'buy',
      priceInCents: 1,
      currency: 'USD',
      productID: 'sku-1',
      transactionID: 'order-42',
    });
    const body = transport.requestsTo('/add_payment_event')[0]?.body as Record<string, unknown>;
    expect(body['transaction_id']).toBe('order-42');
    client.dispose();
  });

  it('reports an invalid date instead of rejecting', async () => {
    const onError = vi.fn();
    const { client } = await authed({ onError });
    await expect(
      new PaymentEventsHandler(client).logCustomPurchase({
        type: 'buy',
        priceInCents: 1,
        currency: 'USD',
        productID: 'sku-1',
        startDate: new Date('not a date'),
      }),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(GrovsError.eventDispatchFailed, expect.any(String));
    client.dispose();
  });
});

describe('one visit reports one app_open', () => {
  it('a replacement client for the same visit does not re-emit launch events', async () => {
    const storage = new FakeStorage();
    const first = make({}, storage);
    first.transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    await first.client.configure();
    first.client['startEventPipeline'](false);
    first.client.dispose();

    const second = make({}, storage);
    second.transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    await second.client.configure();
    second.client['startEventPipeline'](false);
    second.client.shutdown();

    // Counted on the wire, not in the queue: the replacement delivers what
    // the first client left behind, so the queue is empty by now.
    const opens = [
      ...first.transport.requestsTo('/events/batch'),
      ...second.transport.requestsTo('/events/batch'),
    ]
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events)
      .filter((event) => event['event'] === 'app_open');
    expect(opens).toHaveLength(1);
    // An injected store is a test harness and is used unscoped.
    expect(storage.get('grovs_opens')).toBe('1');
    second.client.dispose();
  });
});

describe('link results belong to the visitor that asked', () => {
  it('resolves null when a reset lands while the request is in flight', async () => {
    const { client, transport } = await authed();
    let release!: (value: { ok: boolean; status: number; body: unknown }) => void;
    transport.hold = new Promise((resolve) => {
      release = resolve;
    });
    const pending = new LinkGenerator(client).generateLink({ title: 'x' });
    client.reset();
    release({ ok: true, status: 200, body: { link: 'https://previous-visitor' } });
    await expect(pending).resolves.toBeNull();
    client.dispose();
  });
});

describe('a detached list does not take the detail modals with it', () => {
  it('keeps a live detail modal when the host page swaps the body', async () => {
    document.body.innerHTML = '';
    const { client, transport } = await authed();
    transport.fallback = { ok: true, status: 200, body: { notifications: [] } };
    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    await ui.showMessagesList();
    ui.openPage({ id: 5, title: 'T', subtitle: '', read: false, access_url: 'https://x.com' });

    // The host framework removes the list, not knowing the SDK owns it.
    document.getElementById('Grovs-modal')?.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));

    expect(document.getElementById('Grovs-page-modal-5')).not.toBeNull();
    ui.close();
    client.dispose();
  });
});

describe('reset() means stopped, from every direction', () => {
  // The `online` listener now lives for the client's whole life, so it sees
  // states it did not before. Reconnecting is not a reason to start again.
  it('coming back online after a reset does not re-authenticate', async () => {
    const { client, transport } = await authed();
    client.reset();
    const before = transport.requestsTo('/authenticate').length;

    window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.requestsTo('/authenticate')).toHaveLength(before);
    expect(client.isAuthenticated()).toBe(false);
    client.dispose();
  });

  it('still finishes an initialization that a transient failure interrupted', async () => {
    const transport = new FakeTransport();
    transport.enqueueStatus(503).enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });
    await client.configure();
    expect(client.isAuthenticated()).toBe(false);

    window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.isAuthenticated()).toBe(true);
    client.dispose();
  });
});

describe('the launch guard is per page load and per project', () => {
  it('a second project on the same page still emits its own launch events', async () => {
    const storageA = new FakeStorage();
    const first = make({ apiKey: 'project-a' }, storageA);
    first.transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    await first.client.configure();
    first.client['startEventPipeline'](false);
    first.client.shutdown();
    first.client.dispose();

    const storageB = new FakeStorage();
    const second = make({ apiKey: 'project-b' }, storageB);
    second.transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    await second.client.configure();
    second.client['startEventPipeline'](false);
    second.client.shutdown();

    expect(stored(storageA).filter((e) => e.event === 'app_open')).toHaveLength(1);
    expect(stored(storageB).filter((e) => e.event === 'app_open')).toHaveLength(1);
    expect(storageB.get('grovs_opens')).toBe('1');
    second.client.dispose();
  });
});

describe('the exit path settles attribution before it sends', () => {
  it('marks and persists what it sends while the payload lookup is still open', async () => {
    const storage = new FakeStorage();
    const { client } = await authed({}, storage);
    // Authenticated, so transmission is allowed — but attribution is not
    // settled. This is the window between the authenticate response and the
    // payload lookup answering, which a visitor can leave inside.
    client.eventsHandler.resetDelivery();

    client.track('left_early');
    client.eventsHandler.flushOnExit();

    const event = stored(storage).find((e) => e.eventName === 'left_early');
    expect(event?.pathFinal).toBe(true);

    // So the next page load, on a campaign, cannot re-attribute it.
    const next = make({}, storage);
    next.client.eventsHandler.onPathResolved('promo-campaign');
    next.client.shutdown();
    expect(stored(storage).find((e) => e.eventName === 'left_early')?.path).toBeUndefined();
    next.client.dispose();
    client.dispose();
  });
});

describe('nothing leaves the device before consent, at the wire', () => {
  // The consent gate is the compliance-grade guarantee. Pinned on the
  // transport, not on a stub: the handler tests inject a fake gate, so
  // removing the real one left them all passing.
  it('sends no request at all while consent is pending', async () => {
    const { client, transport } = make({ requireConsent: true });
    // Delivery is otherwise unblocked, so the consent gate is the only thing
    // left standing between these events and the network.
    client.eventsHandler.onPathResolved(null);

    client.track('before_consent');
    client.trackScreenView('Checkout');
    await client.flush();
    client.eventsHandler.flushOnExit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.requests).toHaveLength(0);
    client.dispose();
  });

  it('sends what it held once consent arrives', async () => {
    const { client, transport } = make({ requireConsent: true });
    client.track('before_consent');
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    await client.grantConsent();
    await client.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events)
      .map((e) => e['event_name']);
    expect(sent).toContain('before_consent');
    client.dispose();
  });
});

describe('an unanswered keepalive does not multiply requests', () => {
  it('a second hide sends nothing while the first is still open', async () => {
    const { client, transport } = await authed();
    client.track('one');
    transport.hold = new Promise(() => {});
    client.eventsHandler.flushOnExit();
    const after = transport.requestsTo('/events/batch').length;
    expect(after).toBe(1);

    client.eventsHandler.flushOnExit();
    expect(transport.requestsTo('/events/batch')).toHaveLength(after);
    client.dispose();
  });

  // The queue stays above the batch threshold while a keepalive holds 50
  // events, so counting them made every further track() its own request.
  it('does not start a request per event while a full batch is in flight', async () => {
    const { client, transport } = await authed();
    // One under the batch threshold, so nothing has flushed yet.
    for (let i = 0; i < 49; i += 1) client.track(`e${i}`);
    expect(transport.requestsTo('/events/batch')).toHaveLength(0);

    // The hide sends them all as one keepalive request that is never answered.
    transport.hold = new Promise(() => {});
    client.eventsHandler.flushOnExit();
    const inFlight = transport.requestsTo('/events/batch').length;
    expect(inFlight).toBe(1);

    // The queue now reads 59, but 49 of those are already on the wire.
    for (let i = 0; i < 10; i += 1) client.track(`later${i}`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.requestsTo('/events/batch')).toHaveLength(inFlight);
    client.dispose();
  });
});

describe('a server that asks for a delay gets one', () => {
  it('holds size-triggered flushes for the interval the server named', async () => {
    const { client, transport } = await authed();
    transport.fallback = { ok: false, status: 429, body: {}, retryAfterMs: 120_000 };
    for (let i = 0; i < 50; i += 1) client.track(`e${i}`);
    await client.flush();
    const after = transport.requestsTo('/events/batch').length;

    for (let i = 0; i < 60; i += 1) client.track(`more${i}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.requestsTo('/events/batch')).toHaveLength(after);
    client.dispose();
  });
});

describe('a deterministic failure is not retried', () => {
  it('gives up immediately on a body that cannot be serialized', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const started = Date.now();
    const response = await new FetchTransport().send({
      method: 'POST',
      url: 'https://example.invalid/x',
      headers: {},
      body: cyclic,
    });
    expect(response.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(200);
    vi.unstubAllGlobals();
  });
});

describe('a store that starts refusing writes keeps one session', () => {
  it('returns the same id on every read when the store takes nothing', () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const session = new SessionManager(storage, new FakeClock());
    expect(session.currentSessionId()).toBe(session.currentSessionId());
  });

  it('gives consecutive events the same session id', async () => {
    const storage = new FakeStorage();
    const { client } = await authed({}, storage);
    // The store starts refusing and loses what it held — a full quota that
    // was evicted, which is how this shows up in the wild.
    storage.failWrites = true;
    storage.map.delete('grovs_session_id');
    client.track('one');
    client.track('two');
    const ids = new Set(client.eventsHandler['deps'].queue.all().map((e) => e.sessionId));
    expect(ids.size).toBe(1);
    client.dispose();
  });
});

describe('inputs from the address bar are bounded', () => {
  it('ignores an oversized deep-link parameter instead of storing it', async () => {
    const storage = new FakeStorage();
    const huge = 'x'.repeat(2000);
    const original = window.location.href;
    Object.defineProperty(window, 'location', {
      value: { ...window.location, href: `https://app.example.com/?grovs=${huge}` },
      configurable: true,
    });
    try {
      const { client } = make({}, storage);
      client.eventsHandler.onPathResolved(null);
      expect(storage.get('Grovs_path')).toBeNull();
      client.dispose();
    } finally {
      Object.defineProperty(window, 'location', {
        value: { href: original },
        configurable: true,
      });
    }
  });

  it('falls back to the default for an unrecognised debug level', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client } = make({ debugLevel: 'silent' as 'info' });
    // 'silent' used to rank above every message and mute errors too.
    client.log.reportError(GrovsError.networkRequestFailed, 'still reported');
    expect(error).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
    client.dispose();
  });
});

describe('bounds on hostile or misconfigured input stay bounded', () => {
  // Caps are exactly the code that regresses silently: nothing fails when one
  // is removed, until the day something arrives that needed it.
  it('caps the deep-link parameter and ignores an empty one', () => {
    const storage = new FakeStorage();
    const clock = new FakeClock();
    let href = 'https://app.example.com/?grovs=real-campaign';
    const resolver = new DeeplinkResolver(storage, () => href);
    expect(resolver.capture()).toBe('real-campaign');

    // An empty parameter on a later page of the same visit is not a capture.
    href = 'https://app.example.com/?grovs=';
    expect(resolver.capture()).toBe('real-campaign');
    expect(storage.get(STORED_PATH_KEY)).toBe('real-campaign');

    // Nor is a parameter long enough to fill the origin's quota.
    href = `https://app.example.com/?grovs=${'x'.repeat(600)}`;
    expect(resolver.capture()).toBe('real-campaign');
    expect(storage.get(STORED_PATH_KEY)).toBe('real-campaign');
    expect(clock).toBeDefined();
  });

  it('caps how many messages automatic display can open at once', async () => {
    document.body.innerHTML = '';
    const { client, transport } = await authed();
    transport.fallback = {
      ok: true,
      status: 200,
      body: {
        notifications: Array.from({ length: 40 }, (_, i) => ({
          id: i + 1,
          title: `M${i}`,
          subtitle: '',
          read: false,
          access_url: 'https://x.com',
        })),
      },
    };
    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    await ui.displayAutomaticMessages();

    expect(document.querySelectorAll('.grovs-page-modal')).toHaveLength(5);
    ui.close();
    client.dispose();
  });

  it('caps the tombstone set so a long session cannot grow it without bound', () => {
    const queue = new PersistedQueue(new FakeStorage(), new FakeClock());
    for (let i = 0; i < 1500; i += 1) {
      queue.add({ id: `d${i}`, eventName: 'e', createdAt: i, sessionId: 's' });
      queue.remove([`d${i}`]);
    }
    expect(queue['removedIds'].size).toBeLessThanOrEqual(1000);
  });

  it('caps the path it will match aliases against', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '*': 'Anything' });
    expect(aliases.resolve('/short')).toBe('Anything');
    expect(aliases.resolve(`/${'a'.repeat(600)}`)).toBeNull();
  });

  it('clears the retry cooldown once a batch succeeds', async () => {
    const { client, transport } = await authed();
    transport.fallback = { ok: false, status: 503, body: {} };
    for (let i = 0; i < 50; i += 1) client.track(`e${i}`);
    await client.flush();

    transport.fallback = { ok: true, status: 200, body: { accepted: 50, rejected: 0, errors: [] } };
    await client.flush();
    const afterSuccess = transport.requestsTo('/events/batch').length;

    // The cooldown from the failure must be gone, or a full queue waits out a
    // whole interval after the backend already recovered.
    for (let i = 0; i < 50; i += 1) client.track(`again${i}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.requestsTo('/events/batch').length).toBeGreaterThan(afterSuccess);
    client.dispose();
  });
});

describe('a throttled backend is not hammered past the delay it asked for', () => {
  it('stops retrying in-request when the server names a long delay', async () => {
    const calls: number[] = [];
    vi.stubGlobal('fetch', () => {
      calls.push(Date.now());
      return Promise.resolve(
        new Response('{}', { status: 429, headers: { 'retry-after': '120' } }),
      );
    });
    try {
      const started = Date.now();
      const response = await new FetchTransport().send({
        method: 'POST',
        url: 'https://example.invalid/x',
        headers: {},
        body: {},
      });
      // One attempt, not three, and no five-second wait before giving up.
      expect(calls).toHaveLength(1);
      expect(response.retryAfterMs).toBe(120_000);
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still retries a short delay the server named', async () => {
    let served = 0;
    vi.stubGlobal('fetch', () => {
      served += 1;
      return Promise.resolve(
        served === 1
          ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } })
          : new Response('{"ok":1}', { status: 200 }),
      );
    });
    try {
      const response = await new FetchTransport().send({
        method: 'POST',
        url: 'https://example.invalid/x',
        headers: {},
        body: {},
      });
      expect(served).toBe(2);
      expect(response.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the scheduled drain waits out the delay, an explicit flush does not', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
      const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });
      await client.configure();
      client.eventsHandler.onPathResolved(null);

      transport.fallback = { ok: false, status: 429, body: {}, retryAfterMs: 120_000 };
      client.track('throttled');
      await client.flush();
      const afterFirst = transport.requestsTo('/events/batch').length;
      expect(afterFirst).toBeGreaterThan(0);

      // Two interval ticks inside the window the server asked for.
      await vi.advanceTimersByTimeAsync(70_000);
      expect(transport.requestsTo('/events/batch')).toHaveLength(afterFirst);

      // The integrator asking directly is still honoured.
      await client.flush();
      expect(transport.requestsTo('/events/batch').length).toBeGreaterThan(afterFirst);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the first visit does not wait for a tick', () => {
  // Every flush before attribution settles returns without sending, so
  // nothing carried the launch events until the next interval. A visit
  // shorter than that depended on the exit flush surviving the tab closing.
  it('sends the launch batch as soon as attribution settles', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage() },
    );
    await client.configure();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events)
      .map((e) => e['event']);
    expect(sent).toContain('install');
    expect(sent).toContain('app_open');
    client.dispose();
  });

  it('carries events an earlier visit never delivered in that same first batch', async () => {
    const storage = new FakeStorage();
    // A previous page load queued this and never got it out.
    storage.set(
      QUEUE_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'from-last-visit',
          eventName: 'abandoned_cart',
          createdAt: Date.now(),
          sessionId: 's',
          pathFinal: true,
        },
      ]),
    );

    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage });
    await client.configure();

    const first = transport.requestsTo('/events/batch')[0];
    const names = (first?.body as { events: Record<string, unknown>[] }).events.map(
      (e) => e['event'] ?? e['event_name'],
    );
    expect(names).toContain('abandoned_cart');
    expect(names).toContain('app_open');
    client.dispose();
  });
});

describe('a reset stops work already in flight', () => {
  // The drain loops until the queue is empty. A reset withdraws permission to
  // send, and without checking that the loop walked straight on into the new
  // visitor's queue and sent their events before their attribution resolved.
  it('a drain in progress does not continue into the next visitor\'s queue', async () => {
    const { client, transport } = await authed();
    for (let i = 0; i < 60; i += 1) client.track(`e${i}`);

    transport.hold = new Promise((resolve) =>
      setTimeout(() => resolve({ ok: true, status: 200, body: {} }), 0),
    );
    const draining = client.flush();
    client.eventsHandler.resetDelivery();
    await draining;

    // One batch left, not the second half of the drain.
    expect(transport.requestsTo('/events/batch')).toHaveLength(1);
    client.dispose();
  });
});

describe('a store that goes read-only still rotates the session once', () => {
  it('keeps the rotated id instead of reading the stale one back', () => {
    const storage = new FakeStorage();
    const clock = new FakeClock();
    const session = new SessionManager(storage, clock);

    const before = session.currentSessionId();
    expect(storage.get('grovs_session_id')).toBe(before);

    // The quota fills; old values stay readable, new ones are refused.
    clock.advanceMinutes(31);
    storage.failWrites = true;

    const rotated = session.currentSessionId();
    expect(rotated).not.toBe(before);
    // And it stays rotated, rather than rotating again on every read.
    expect(session.currentSessionId()).toBe(rotated);
    expect(session.currentSessionId()).toBe(rotated);
  });
});

describe('authentication respects a throttled backend', () => {
  it('waits the delay the server named before retrying', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      transport.fallback = { ok: false, status: 429, body: {}, retryAfterMs: 120_000 };
      const client = new GrovsClient(
        { apiKey: 'k' },
        { transport, storage: new FakeStorage(), autoStartEvents: false },
      );
      await client.configure();
      expect(transport.requestsTo('/authenticate')).toHaveLength(1);

      // The ordinary 30-second retry must not fire inside the server's window.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(transport.requestsTo('/authenticate')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(70_000);
      expect(transport.requestsTo('/authenticate').length).toBeGreaterThan(1);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a reconnect does not bypass a delay the server named', () => {
  it('holds authentication until the server-named deadline, even on `online`', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      transport.fallback = { ok: false, status: 429, body: {}, retryAfterMs: 120_000 };
      const client = new GrovsClient(
        { apiKey: 'k' },
        { transport, storage: new FakeStorage(), autoStartEvents: false },
      );
      await client.configure();
      expect(transport.requestsTo('/authenticate')).toHaveLength(1);

      // Reconnecting is not permission to ignore it.
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(10);
      expect(transport.requestsTo('/authenticate')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(130_000);
      expect(transport.requestsTo('/authenticate').length).toBeGreaterThan(1);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still retries immediately on `online` after a dead connection', async () => {
    const transport = new FakeTransport();
    transport.enqueueStatus(0).enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });
    await client.configure();
    expect(client.isAuthenticated()).toBe(false);

    window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.isAuthenticated()).toBe(true);
    client.dispose();
  });
});

describe('the pending-attribution set follows the queue', () => {
  it('does not grow past the queue cap while consent is pending', () => {
    const { client } = make({ requireConsent: true });
    for (let i = 0; i < 3000; i += 1) client.track(`e${i}`);
    expect(pendingAttributionSize()).toBeLessThanOrEqual(1000);
    client.dispose();
  });
});

describe('a reset clears every project on the origin', () => {
  it('does not leave another project\'s queue to be sent under the new visitor', () => {
    localStorage.clear();
    localStorage.setItem('linksquared', 'old-visitor');
    localStorage.setItem(
      scopedKey(QUEUE_STORAGE_KEY, 'project-b'),
      JSON.stringify([
        { id: 'b1', eventName: 'from_project_b', createdAt: Date.now(), sessionId: 's' },
      ]),
    );

    const client = new GrovsClient(
      { apiKey: 'project-a' },
      { transport: new FakeTransport(), autoStartEvents: false },
    );
    client.reset();

    // The identifier is shared across projects, so an orphaned queue would be
    // re-sent under whatever identity the next configure() mints.
    expect(localStorage.getItem(scopedKey(QUEUE_STORAGE_KEY, 'project-b'))).toBeNull();
    expect(localStorage.getItem('linksquared')).toBeNull();
    client.dispose();
    localStorage.clear();
  });
});

describe('storage recovering does not split a visit across tabs', () => {
  it('writes the rotated session id back once the store accepts writes', () => {
    const storage = new FakeStorage();
    const clock = new FakeClock();
    const session = new SessionManager(storage, clock);
    const before = session.currentSessionId();

    clock.advanceMinutes(31);
    storage.failWrites = true;
    const rotated = session.currentSessionId();
    expect(rotated).not.toBe(before);
    expect(storage.get('grovs_session_id')).toBe(before);

    // The quota frees up. A sibling tab reads this key, so it has to hold the
    // id this tab is actually using, not the one it replaced.
    storage.failWrites = false;
    session.currentSessionId();
    expect(storage.get('grovs_session_id')).toBe(rotated);
  });
});

describe('interacting states, in the order that breaks them', () => {
  // An ordinary batch and a keepalive batch are both in flight every time a
  // page is hidden mid-drain, and their answers arrive in either order.
  it('a later success does not clear a cooldown another response asked for', async () => {
    const { client, transport } = await authed();
    client.track('one');

    // The throttled answer lands first and names two minutes.
    transport.fallback = { ok: false, status: 429, body: {}, retryAfterMs: 120_000 };
    await client.flush();

    // Then an unrelated request succeeds.
    transport.fallback = { ok: true, status: 200, body: { accepted: 1, rejected: 0, errors: [] } };
    client.eventsHandler.flushOnExit();
    await client.flush();

    // The scheduled drain still owes the server its two minutes.
    const settled = transport.requestsTo('/events/batch').length;
    for (let i = 0; i < 60; i += 1) client.track(`later${i}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.requestsTo('/events/batch')).toHaveLength(settled);
    client.dispose();
  });

  it('a stale reset notification does not stop the visitor who replaced them', async () => {
    localStorage.clear();
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient({ apiKey: 'k' }, { transport });
    await client.configure();
    expect(client.isAuthenticated()).toBe(true);

    // A background tab is handed the removal of an identity this client has
    // already moved on from.
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'linksquared',
        oldValue: 'a-visitor-we-no-longer-are',
        newValue: null,
      }),
    );
    expect(client.isAuthenticated()).toBe(true);

    // The removal of the identity actually held still stops it.
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'linksquared', oldValue: 'v1', newValue: null }),
    );
    expect(client.isAuthenticated()).toBe(false);
    client.dispose();
    localStorage.clear();
  });

  it('recovering storage adopts a sibling\'s newer session instead of overwriting it', () => {
    const storage = new FakeStorage();
    const clock = new FakeClock();
    const session = new SessionManager(storage, clock);
    const original = session.currentSessionId();

    // This tab rotates while the store refuses writes.
    clock.advanceMinutes(31);
    storage.failWrites = true;
    const mine = session.currentSessionId();
    expect(mine).not.toBe(original);

    // The store recovers, and a sibling tab starts a session of its own.
    storage.failWrites = false;
    storage.set('grovs_session_id', 'sibling-session');

    // A session is a person, not a tab: join theirs rather than replace it.
    expect(session.currentSessionId()).toBe('sibling-session');
    expect(storage.get('grovs_session_id')).toBe('sibling-session');
  });
});

describe('a running drain stops when the backend starts shedding load', () => {
  /**
   * A hide mid-drain puts a keepalive batch on the wire beside the ordinary
   * one, so a 429 can answer either, in either order. The loop was checking
   * only whether the client was still allowed to send, so it carried on
   * through the rest of the queue milliseconds after the server asked for
   * two minutes.
   *
   * Answering each batch by hand is the point: with an auto-answering
   * transport the first drain is over before the keepalive is even sent, and
   * the interleaving under test never happens.
   */
  class BatchGate implements Transport {
    readonly batches: { resolve: (response: TransportResponse) => void }[] = [];

    send(request: TransportRequest): Promise<TransportResponse> {
      if (request.url.endsWith('/authenticate')) {
        return Promise.resolve({ ok: true, status: 200, body: { linksquared: 'v1' } });
      }
      if (request.url.includes('data_for_device')) {
        return Promise.resolve({ ok: true, status: 200, body: { data: null } });
      }
      if (request.url.endsWith('/events/batch')) {
        return new Promise((resolve) => this.batches.push({ resolve }));
      }
      return Promise.resolve({ ok: true, status: 200, body: {} });
    }
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };

  const THROTTLED: TransportResponse = {
    ok: false,
    status: 429,
    body: {},
    retryAfterMs: 120_000,
  };
  const ACCEPTED: TransportResponse = {
    ok: true,
    status: 200,
    body: { accepted: 50, rejected: 0, errors: [] },
  };

  /** A drain in progress, a keepalive beside it, answered in the given order. */
  async function throttledMidDrain(order: 'keepalive-first' | 'ordinary-first') {
    const transport = new BatchGate();
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();

    // The 50th starts an ordinary drain, which stays open.
    for (let i = 0; i < 150; i += 1) client.track(`e${i}`);
    await settle();
    expect(transport.batches).toHaveLength(1);

    // Hiding the page puts a keepalive batch on the wire beside it.
    client.eventsHandler.flushOnExit();
    await settle();
    expect(transport.batches).toHaveLength(2);

    const ordinary = transport.batches[0]!;
    const keepalive = transport.batches[1]!;
    if (order === 'keepalive-first') {
      keepalive.resolve(THROTTLED);
      await settle();
      ordinary.resolve(ACCEPTED);
    } else {
      ordinary.resolve(THROTTLED);
      await settle();
      keepalive.resolve(ACCEPTED);
    }
    await settle();
    return { client, transport };
  }

  for (const order of ['keepalive-first', 'ordinary-first'] as const) {
    it(`stops the running drain when the throttle answers ${order}`, async () => {
      const { client, transport } = await throttledMidDrain(order);

      // 100 events are still queued and the loop had every reason to send
      // them; the server asked for two minutes.
      expect(transport.batches).toHaveLength(2);
      client.dispose();
    });
  }

  it('an explicit flush still drains through the cooldown', async () => {
    const { client, transport } = await throttledMidDrain('keepalive-first');
    expect(transport.batches).toHaveLength(2);

    void client.flush();
    await settle();
    // The integrator asked directly, so the whole remaining queue goes: 100
    // events left, two more batches. A scheduled drain would have sent none.
    expect(transport.batches).toHaveLength(3);
    transport.batches[2]!.resolve(ACCEPTED);
    await settle();
    expect(transport.batches).toHaveLength(4);
  });

  // The documented exception: an explicit flush joins a scheduled drain
  // rather than doubling it, so a throttle that stops that drain leaves this
  // call resolving with the queue still full. Continuing here would re-send
  // a merely-failed batch, so the README carries the caveat instead.
  it('resolves early when it joined a scheduled drain that got throttled', async () => {
    const transport = new BatchGate();
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();

    for (let i = 0; i < 150; i += 1) client.track(`e${i}`);
    await settle();
    expect(transport.batches).toHaveLength(1);

    const asked = client.flush();
    transport.batches[0]!.resolve(THROTTLED);
    await asked;

    expect(client.eventsHandler['deps'].queue.size()).toBeGreaterThan(0);
    client.dispose();
  });

  it('scheduled delivery resumes once the deadline passes', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
      const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });
      await client.configure();
      client.eventsHandler.onPathResolved(null);

      transport.fallback = { ok: false, status: 429, body: {}, retryAfterMs: 120_000 };
      client.track('throttled');
      await client.flush();
      const settled = transport.requestsTo('/events/batch').length;

      transport.fallback = { ok: true, status: 200, body: { accepted: 1, rejected: 0, errors: [] } };
      await vi.advanceTimersByTimeAsync(60_000);
      expect(transport.requestsTo('/events/batch')).toHaveLength(settled);

      await vi.advanceTimersByTimeAsync(70_000);
      expect(transport.requestsTo('/events/batch').length).toBeGreaterThan(settled);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
