import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scopedKey } from '../../src/storage/scoped-storage';
import { GrovsClient, __resetPendingConsentStore } from '../../src/core/client';
import { MessagesService } from '../../src/messages/messages';
import { PersistedQueue } from '../../src/storage/persisted-queue';
import { FakeTransport } from '../helpers/fake-transport';
import type { TransportRequest, TransportResponse } from '../../src/net/transport';
import { FakeStorage } from '../helpers/fake-storage';
import { FakeClock } from '../helpers/fake-clock';

const AUTH_OK = {
  ok: true,
  status: 200,
  body: { linksquared: 'v1', sdk_identifier: null, sdk_attributes: null },
};

function clearBrowserStorage(): void {
  localStorage.clear();
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
  });
}

describe('messages respect consent, enabled and authentication', () => {
  beforeEach(clearBrowserStorage);

  // Config promises "nothing is persisted or transmitted until grantConsent()".
  // The messages endpoints were the one public surface not checking.
  it('sends no message request before consent is granted', async () => {
    const transport = new FakeTransport();
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();

    const messages = new MessagesService(client);
    await messages.getMessages(1);
    await messages.numberOfUnreadMessages();
    await messages.markMessageAsRead(1);
    await messages.messagesForAutomaticDisplay();

    expect(transport.requests).toHaveLength(0);
    client.shutdown();
  });

  // "Disabling stops the SDK, it does not merely mute it."
  it('sends no message request after setEnabled(false)', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();
    client.setEnabled(false);
    transport.requests.length = 0;

    await new MessagesService(client).getMessages(1);

    expect(transport.requests).toHaveLength(0);
  });

  it('still works once authenticated and enabled', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();
    transport.enqueue({ ok: true, status: 200, body: { number_of_unread_notifications: 3 } });

    await expect(new MessagesService(client).numberOfUnreadMessages()).resolves.toBe(3);
    client.shutdown();
  });
});

describe('deep link attribution does not outlive its visit', () => {
  beforeEach(clearBrowserStorage);

  // T2 split read from consume precisely so the path could be retired once
  // used; nothing ever consumed it, so campaign A followed the visitor for ever.
  it('consumes the stored path once it has been attributed', async () => {
    const storage = new FakeStorage();
    storage.set('Grovs_path', 'campaign-a');

    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage, autoStartEvents: false });
    await client.configure();

    expect(storage.get('Grovs_path')).toBeNull();
    client.shutdown();
  });

  /**
   * Consuming the durable copy retired the value the handlers read from, so
   * everything after configure() — screen views, custom events, the final
   * time_spent — lost its path. The arrival was attributed and the whole
   * session behind it was not.
   */
  it('keeps stamping the path on events for the rest of the visit', async () => {
    const storage = new FakeStorage();
    storage.set('Grovs_path', 'campaign-a');

    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage, autoStartEvents: false });
    await client.configure();

    client.track('after-configure');
    client.eventsHandler.onPathResolved(null);
    await client.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);

    expect(sent[0]?.['path']).toBe('campaign-a');
    // ...while the durable copy is gone, so it cannot follow them to a later
    // direct visit.
    expect(storage.get('Grovs_path')).toBeNull();
    client.shutdown();
  });

  // A 5xx must not cost the campaign attribution: the next load retries.
  it('keeps the stored path when the payload lookup fails', async () => {
    const storage = new FakeStorage();
    storage.set('Grovs_path', 'campaign-a');

    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueueStatus(500, {});
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage, autoStartEvents: false });
    await client.configure();

    expect(storage.get('Grovs_path')).toBe('campaign-a');
    client.shutdown();
  });

  // The callback is the integrator's code; a throw from it left pathResolved
  // false, so every flush for the rest of the visit silently did nothing.
  it('still delivers events when onDeeplink throws', async () => {
    const transport = new FakeTransport();
    transport
      .enqueue(AUTH_OK)
      .enqueue({ ok: true, status: 200, body: { data: { screen: 'x' } } });

    const client = new GrovsClient(
      {
        apiKey: 'k',
        onDeeplink: () => {
          throw new Error('integrator bug');
        },
      },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );

    await expect(client.configure()).resolves.toBe(true);

    client.track('after-throw');
    await client.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);
    expect(sent.map((e) => e['event_name'])).toContain('after-throw');
    client.shutdown();
  });

  it('sends the path on the visit that carried it', async () => {
    const storage = new FakeStorage();
    storage.set('Grovs_path', 'campaign-a');

    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage, autoStartEvents: false });
    await client.configure();

    const call = transport.requestsTo('/data_for_device_and_path')[0];
    expect((call?.body as Record<string, unknown>)['path']).toBe('campaign-a');
    client.shutdown();
  });
});

describe('consent does not discard a queue from an earlier visit', () => {
  beforeEach(clearBrowserStorage);

  // The queue is built over empty memory in consent mode, so an unconditional
  // write on grant erased whatever a previous visit had left behind.
  it('merges the durable queue instead of overwriting it', async () => {
    // A real timestamp: createdAt near epoch is correctly pruned as stale
    // before it can be sent, which would test the wrong thing.
    localStorage.setItem(
      scopedKey('grovs_events', 'k'),
      JSON.stringify([
        { id: 'from-previous-visit', createdAt: Date.now(), event: 'app_open', sessionId: 's' },
      ]),
    );

    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();
    client.track('this-visit');
    await client.grantConsent();

    client.eventsHandler.onPathResolved(null);
    await client.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);

    expect(sent.map((e) => e['event_id'])).toContain('from-previous-visit');
    expect(sent.map((e) => e['event_name'])).toContain('this-visit');
    client.shutdown();
  });

  it('merges without duplicating events already held in memory', () => {
    const storage = new FakeStorage();
    const clock = new FakeClock();
    const queue = new PersistedQueue(storage, clock);

    queue.add({ id: 'a', createdAt: clock.now(), event: 'view', sessionId: 's' });
    queue.flushToStorage();
    queue.mergeFromStorage();

    expect(queue.all().map((e) => e.id)).toEqual(['a']);
  });
});

describe('reset clears what it says it clears', () => {
  beforeEach(clearBrowserStorage);

  it('drops received deep link payloads', async () => {
    const transport = new FakeTransport();
    transport
      .enqueue(AUTH_OK)
      .enqueue({ ok: true, status: 200, body: { data: { screen: 'checkout' } } });
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();
    expect(client.allReceivedPayloadsSinceStartup()).toHaveLength(1);

    client.reset();

    expect(client.allReceivedPayloadsSinceStartup()).toEqual([]);
    expect(client.lastReceivedPayload()).toBeNull();
  });
});

describe('concurrent configure()', () => {
  beforeEach(clearBrowserStorage);

  // A slow first call could finish after a second and restart its own timers,
  // leaving two pipelines live.
  it('lets the later call win when two overlap', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );

    const [first, second] = await Promise.all([client.configure(), client.configure()]);

    expect(first).toBe(false);
    expect(second).toBe(true);
    client.shutdown();
  });
});

describe('a retired client stays retired', () => {
  beforeEach(clearBrowserStorage);

  // The generation counter is per-client, so it cannot see the facade
  // replacing one client with another. Only dispose() can.
  it('does not resume after dispose, even if its authentication was in flight', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage() },
    );

    const pending = client.configure();
    client.dispose();

    await expect(pending).resolves.toBe(false);
  });

  /**
   * Retirement and teardown are different operations. Conflating them made
   * reset() and setEnabled(false) brick the client, so withdrawing consent
   * and granting it again — the ordinary GDPR cycle the README and
   * MIGRATION.md both teach — authenticated and then returned false.
   */
  it('can be granted consent again after reset', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );

    await expect(client.grantConsent()).resolves.toBe(true);
    client.reset();

    await expect(client.grantConsent()).resolves.toBe(true);
    expect(client.isAuthenticated()).toBe(true);
    client.shutdown();
  });

  it('can configure again after reset', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );

    await client.configure();
    client.reset();

    await expect(client.configure()).resolves.toBe(true);
    client.shutdown();
  });

  it('can configure again after a disable/enable cycle', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );

    await client.configure();
    client.setEnabled(false);
    client.setEnabled(true);

    await expect(client.configure()).resolves.toBe(true);
    client.shutdown();
  });

  // A superseded attempt's failure is not the active configuration's failure.
  it('does not report an obsolete authentication failure', async () => {
    const onError = vi.fn();
    const transport = new FakeTransport();
    transport.enqueueStatus(403, { error: 'Invalid credentials' });
    const client = new GrovsClient(
      { apiKey: 'k', onError },
      { transport, storage: new FakeStorage() },
    );

    const pending = client.configure();
    client.dispose();
    await pending;

    expect(onError).not.toHaveBeenCalled();
  });
});

describe('consent merge survives the persist debounce', () => {
  beforeEach(clearBrowserStorage);

  // Once the 1s debounce has fired, the pre-consent memory store holds a
  // queue of its own — and copying it across would overwrite the durable one
  // before the merge could read it.
  it('keeps both queues when consent is granted after the debounce', async () => {
    localStorage.setItem(
      scopedKey('grovs_events', 'k'),
      JSON.stringify([
        { id: 'from-previous-visit', createdAt: Date.now(), event: 'app_open', sessionId: 's' },
      ]),
    );

    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();
    client.track('this-visit');

    // Let the debounce write into the pre-consent memory store.
    await new Promise((r) => setTimeout(r, 1100));
    await client.grantConsent();

    client.eventsHandler.onPathResolved(null);
    await client.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);

    expect(sent.map((e) => e['event_id'])).toContain('from-previous-visit');
    expect(sent.map((e) => e['event_name'])).toContain('this-visit');
    client.shutdown();
  });
});

describe('lifecycle changes invalidate work in flight', () => {
  beforeEach(clearBrowserStorage);

  // A pending authenticate landing after the clear re-authenticated the very
  // client that had just been wiped.
  it('does not let a pending configure survive reset()', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );

    const pending = client.configure();
    client.reset();

    await expect(pending).resolves.toBe(false);
    expect(client.isAuthenticated()).toBe(false);
  });

  // Event logging was suppressed, but the intervals, lifecycle listeners and
  // History patch all started on a client that had been told to stop.
  it('does not start tracking when disabled mid-authentication', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });

    const pending = client.configure();
    client.setEnabled(false);

    await expect(pending).resolves.toBe(false);
    client.shutdown();
  });

  // Freezing the queue stopped a late write; it did not stop the loop issuing
  // the batches behind the one already in flight.
  it('stops draining further batches once retired', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();
    client.eventsHandler.onPathResolved(null);

    for (let i = 0; i < 120; i += 1) client.track(`e-${i}`);

    const draining = client.flush();
    client.dispose();
    await draining;

    // The first batch was already in flight; the rest must not follow.
    expect(transport.requestsTo('/events/batch').length).toBeLessThanOrEqual(1);
  });

  it('clears the in-memory campaign path on reset', async () => {
    const storage = new FakeStorage();
    storage.set('Grovs_path', 'campaign-a');
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage, autoStartEvents: false });
    await client.configure();

    client.reset();
    transport.enqueue(AUTH_OK);
    await client.configure();

    client.track('after-reset');
    client.eventsHandler.onPathResolved(null);
    await client.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);
    const after = sent.find((e) => e['event_name'] === 'after-reset');
    expect(after?.['path']).toBeUndefined();
    client.shutdown();
  });

  it('stops message traffic for a retired client', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();
    client.dispose();
    transport.requests.length = 0;

    await new MessagesService(client).getMessages(1);
    expect(transport.requests).toHaveLength(0);
  });
});

describe('consent keeps what was tracked across a reconfigure', () => {
  beforeEach(() => {
    clearBrowserStorage();
    __resetPendingConsentStore();
  });

  /**
   * Consent mode promises that events tracked meanwhile are kept. A per-client
   * memory store broke that on reconfigure: the retired client persisted into
   * an object the replacement never saw.
   */
  it('carries pre-consent events to a replacement client', async () => {
    const first = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport: new FakeTransport(), autoStartEvents: false },
    );
    await first.configure();
    first.track('tracked-before-reconfigure');
    first.dispose();

    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const second = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await second.grantConsent();

    second.eventsHandler.onPathResolved(null);
    await second.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);
    expect(sent.map((e) => e['event_name'])).toContain('tracked-before-reconfigure');
    second.shutdown();
  });
});

describe('the pending-consent store does not outlive its purpose', () => {
  beforeEach(() => {
    clearBrowserStorage();
    __resetPendingConsentStore();
  });

  /**
   * Sharing the store across clients is right; keeping it after its contents
   * moved to localStorage is not. A later consent-pending client read back
   * events that had already been delivered.
   */
  it('does not resurrect delivered events in a second consent cycle', async () => {
    const first = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport: new FakeTransport(), autoStartEvents: false },
    );
    await first.configure();
    first.track('event-A');

    const firstTransport = new FakeTransport();
    firstTransport.enqueue(AUTH_OK);
    const granting = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport: firstTransport, autoStartEvents: false },
    );
    await granting.grantConsent();
    granting.eventsHandler.onPathResolved(null);
    await granting.flush();
    granting.dispose();

    // A second consent-pending client must start clean.
    localStorage.removeItem(scopedKey('grovs_events', 'k'));
    const secondTransport = new FakeTransport();
    secondTransport.enqueue(AUTH_OK);
    const second = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport: secondTransport, autoStartEvents: false },
    );
    await second.grantConsent();
    second.eventsHandler.onPathResolved(null);
    await second.flush();

    const resent = secondTransport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events)
      .map((e) => e['event_name']);

    expect(resent).not.toContain('event-A');
    second.shutdown();
  });

  // reset() is documented as clearing queued events. The shared store held
  // exactly what it had just erased.
  it('does not resurrect events that reset() deleted', async () => {
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport: new FakeTransport(), autoStartEvents: false },
    );
    await client.configure();
    client.track('deleted-by-reset');
    client.reset();

    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const next = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await next.grantConsent();
    next.eventsHandler.onPathResolved(null);
    await next.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events)
      .map((e) => e['event_name']);

    expect(sent).not.toContain('deleted-by-reset');
    next.shutdown();
  });
});

describe('a disabled SDK stays disabled', () => {
  beforeEach(() => {
    clearBrowserStorage();
    __resetPendingConsentStore();
  });

  // "Disabling stops the SDK, it does not merely mute it."
  it('does not authenticate when consent is granted while disabled', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();

    client.setEnabled(false);
    await expect(client.grantConsent()).resolves.toBe(false);

    expect(transport.requests).toHaveLength(0);
    expect(client.isAuthenticated()).toBe(false);
  });

  it('grants normally once re-enabled', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();

    client.setEnabled(false);
    await client.grantConsent();
    client.setEnabled(true);

    await expect(client.grantConsent()).resolves.toBe(true);
    client.shutdown();
  });

  // The list rendered whatever returned, even if the SDK stopped mid-request.
  it('drops an ordinary message response that lands after disable', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();

    transport.enqueue({
      ok: true,
      status: 200,
      body: {
        notifications: [
          { id: 1, title: 'A', subtitle: '', read: false, access_url: 'https://example.com/m' },
        ],
      },
    });

    const service = new MessagesService(client);
    const pending = service.getMessages(1);
    client.setEnabled(false);

    await expect(pending).resolves.toEqual([]);
  });
});

describe('messages re-check after the await', () => {
  beforeEach(clearBrowserStorage);

  // The guard ran before the request. Disabling while it was in flight still
  // popped modals onto a page that had asked the SDK to stop.
  it('opens nothing when the SDK is disabled mid-request', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();

    transport.enqueue({
      ok: true,
      status: 200,
      body: {
        notifications: [
          { id: 1, title: 'A', subtitle: '', read: false, access_url: 'https://example.com/m' },
        ],
      },
    });

    const service = new MessagesService(client);
    const pending = service.messagesForAutomaticDisplay();
    client.setEnabled(false);

    await expect(pending).resolves.toEqual([]);
  });
});

describe('message iframe hardening', () => {
  it('sandboxes remote content and rejects non-http schemes', async () => {
    document.body.replaceChildren();
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();

    const { MessagesUI } = await import('../../src/messages/messages-ui');
    const { Logger } = await import('../../src/logging/logger');
    const ui = new MessagesUI(document, new MessagesService(client), new Logger());

    ui.openPage({
      id: 1,
      title: 'T',
      subtitle: '',
      read: false,
      access_url: 'javascript:alert(1)',
    });

    // The detail modal renders into a shadow root now; pierce it.
    const frame = document
      .getElementById('Grovs-page-modal-1')
      ?.shadowRoot?.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame?.getAttribute('src')).toBe('about:blank');
    client.shutdown();
  });
});

/** Lets a test act at the exact moment a given request is issued. */
class HookedTransport extends FakeTransport {
  onRequest: ((request: TransportRequest) => void) | null = null;

  override send(request: TransportRequest): Promise<TransportResponse> {
    this.onRequest?.(request);
    return super.send(request);
  }
}

describe('withdrawing consent stops delivery, not just storage', () => {
  beforeEach(clearBrowserStorage);

  // reset() clears the queue, the identity and the durable store, and returns
  // the client to its pre-consent state — but the events handler kept the
  // permission to send it was granted by the configure() before the reset, so
  // the next tracked event went out anyway.
  it('sends nothing tracked after reset revokes consent', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.grantConsent();
    client.reset();
    transport.requests.length = 0;

    client.track('after-reset');
    await client.flush();

    expect(transport.requestsTo('/events/batch')).toHaveLength(0);
    client.shutdown();
  });

  it('delivers again once consent is granted a second time', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.grantConsent();
    client.reset();

    client.track('after-reset');
    await client.grantConsent();
    await client.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);
    expect(sent.map((e) => e['event_name'])).toContain('after-reset');
    client.shutdown();
  });
});

describe('an initialization interrupted by disabling', () => {
  beforeEach(clearBrowserStorage);

  // Disabling invalidates whatever configure() has in flight. Interrupted
  // after authentication but before the payload lookup, the client reported
  // itself authenticated while the handler's pathResolved stayed false for
  // ever: re-enabling restarted the timers and every flush sent nothing.
  it('finishes on re-enable rather than resuming half of one', async () => {
    const transport = new HookedTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );

    transport.onRequest = (request) => {
      if (request.url.includes('/data_for_device')) {
        transport.onRequest = null;
        client.setEnabled(false);
      }
    };

    await client.configure();
    expect(client.isAuthenticated()).toBe(true);

    client.setEnabled(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    client.track('after-enable');
    await client.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);
    expect(sent.map((e) => e['event_name'])).toContain('after-enable');
    client.shutdown();
  });

  it('does not authenticate on enable when configure() was never called', async () => {
    const transport = new FakeTransport();
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );

    client.setEnabled(false);
    client.setEnabled(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.requests).toHaveLength(0);
  });
});

describe('consent mode keeps the campaign and the events across a reconfigure', () => {
  beforeEach(() => {
    clearBrowserStorage();
    __resetPendingConsentStore();
    history.replaceState({}, '', '/');
  });

  // The path used to be captured only once consent landed. A router that
  // cleans the query string while the banner is up took the campaign with it,
  // and the visit fell back to fingerprint matching.
  it('captures the campaign before consent, not after', async () => {
    history.replaceState({}, '', '/?Grovs=campaign-c');
    const transport = new FakeTransport();
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();

    // The host router cleans up before the visitor answers the banner.
    history.replaceState({}, '', '/');
    transport.enqueue(AUTH_OK);
    await client.grantConsent();

    const call = transport.requestsTo('/data_for_device_and_path')[0];
    expect((call?.body as Record<string, unknown>)['path']).toBe('campaign-c');
    client.shutdown();
  });

  // The back-fill boundary must be the visit, not the handler: the shared
  // pending store exists so a second configure() before consent keeps what the
  // first client tracked, and those events are still this visit's.
  it('back-fills the campaign onto events the replaced client tracked', async () => {
    history.replaceState({}, '', '/?Grovs=campaign-b');
    const transport = new FakeTransport();

    const first = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await first.configure();
    // The router cleans the URL, and a second configure() replaces the client,
    // both before the visitor answers the banner.
    history.replaceState({}, '', '/');
    first.track('before-consent');
    first.dispose();

    transport.enqueue(AUTH_OK);
    const second = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await second.grantConsent();
    await second.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);
    const event = sent.find((e) => e['event_name'] === 'before-consent');
    expect(event?.['path']).toBe('campaign-b');
    second.shutdown();
  });

  // reset() in consent mode swapped in a private store, so anything tracked
  // before the next configure() was stranded on an object nobody else reads.
  it('keeps events tracked between reset and the next configure', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.grantConsent();
    client.reset();
    client.track('after-reset');
    client.dispose();

    transport.enqueue(AUTH_OK);
    const next = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await next.grantConsent();
    await next.flush();

    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);
    expect(sent.map((e) => e['event_name'])).toContain('after-reset');
    next.shutdown();
  });
});

describe('identity changes made while the SDK is stopped', () => {
  beforeEach(clearBrowserStorage);

  // markIdentityChanged() returned early when disabled, so the flag was never
  // set and the next configure() read the server value back over it.
  it('are pushed by the next configure instead of being overwritten', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );

    client.setEnabled(false);
    client.setUserIdentifier('user-7');
    client.setEnabled(true);
    await client.configure();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.userIdentifier).toBe('user-7');
    expect(transport.requestsTo('/visitor_attributes')).toHaveLength(1);
    client.shutdown();
  });
});

describe('a queued identity update is not a licence to send later', () => {
  beforeEach(() => {
    clearBrowserStorage();
    __resetPendingConsentStore();
  });

  // Serializing the pushes moved the send away from the call that scheduled
  // it. The permission has to be re-checked where the request actually goes
  // out, or a task queued before reset() carries values set after it.
  it('drops a push queued before a reset revoked consent', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.grantConsent();

    client.setUserIdentifier('user-a');
    client.reset();
    client.setUserAttributes({ plan: 'pro' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.requestsTo('/visitor_attributes')).toHaveLength(0);
    client.shutdown();
  });

  // A transport that rejects rather than resolving used to leave every later
  // update chained onto a rejected promise.
  it('keeps the chain usable after a rejected send', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();

    const send = vi
      .spyOn(transport, 'send')
      .mockRejectedValueOnce(new Error('transport exploded'));
    client.setUserIdentifier('user-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    send.mockRestore();

    client.setUserAttributes({ plan: 'pro' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.requestsTo('/visitor_attributes')).toHaveLength(1);
    client.shutdown();
  });
});

describe('the session is a person, not a tab, across consent', () => {
  beforeEach(() => {
    clearBrowserStorage();
    __resetPendingConsentStore();
  });

  // Granting consent copied this tab's memory-only session over the durable
  // one, changing the session id under a sibling tab that was active a second
  // ago and reporting one visit as two.
  it('joins a sibling tab\'s live session instead of replacing it', async () => {
    // Durable storage, because that is what consent migrates onto.
    localStorage.setItem(scopedKey('grovs_session_id', 'k'), 'sibling-session');
    localStorage.setItem(scopedKey('grovs_session_activity', 'k'), String(Date.now() - 1000));

    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();
    client.track('before-consent');
    await client.grantConsent();
    await client.flush();

    expect(localStorage.getItem(scopedKey('grovs_session_id', 'k'))).toBe('sibling-session');
    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);
    const event = sent.find((e) => e['event_name'] === 'before-consent');
    expect(event?.['session_id']).toBe('sibling-session');
    client.shutdown();
  });
});

describe('an undelivered identity update stays owed', () => {
  beforeEach(clearBrowserStorage);

  // The generation guard skipped the send without marking the change dirty,
  // so the value lived only in memory and the next configure() read the server
  // value back over it.
  it('is pushed by the next configure when a disable skipped it', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();

    client.setUserIdentifier('user-a');
    client.setEnabled(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    client.setEnabled(true);
    await client.configure();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.userIdentifier).toBe('user-a');
    client.shutdown();
  });
});

describe('retries stop when the client that made them is gone', () => {
  beforeEach(clearBrowserStorage);

  // reset() moves the lifecycle without withdrawing consent in the default
  // configuration, so the retry guard stayed satisfied and the two attempts
  // behind the first went on sending the visitor id it had just cleared.
  it('abandons a retry begun before a reset', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();

    const request = transport.requestsTo('/authenticate')[0];
    expect(request?.abandon?.()).toBe(false);

    client.reset();

    expect(request?.abandon?.()).toBe(true);
  });
});

describe('an identity change made while stopped is delivered on re-enable', () => {
  beforeEach(clearBrowserStorage);

  async function authed(transport: FakeTransport): Promise<GrovsClient> {
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();
    return client;
  }

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  // Only configure() consumed the flag, and the facade's configure() builds a
  // new client whose flag is clean — so no integrator using the facade ever
  // reached the path the earlier tests exercised.
  it('pushes without waiting for another configure()', async () => {
    const transport = new FakeTransport();
    const client = await authed(transport);

    client.setEnabled(false);
    client.setUserIdentifier('user-a');
    client.setEnabled(true);
    await tick();

    expect(transport.requestsTo('/visitor_attributes')).toHaveLength(1);
    client.shutdown();
  });

  // setUserIdentifier(null) is an instruction to clear. Inferring "pending"
  // from the context could not tell that from having nothing to send.
  it('keeps an explicit clear pending', async () => {
    const transport = new FakeTransport();
    const client = await authed(transport);

    client.setEnabled(false);
    client.setUserIdentifier(null);
    client.setEnabled(true);
    await tick();

    expect(transport.requestsTo('/visitor_attributes')).toHaveLength(1);
    client.shutdown();
  });

  // Two setters inside one request's flight: A's success used to clear the
  // flag for B, which was then forgotten when B failed and the next configure
  // read A's value back from the server.
  it('is not cleared by an acknowledgement for an older change', async () => {
    const transport = new FakeTransport();
    const client = await authed(transport);

    transport.enqueue({ ok: true, status: 200, body: {} }).enqueueStatus(500);
    client.setUserIdentifier('user-a');
    client.setUserIdentifier('user-b');
    await tick();
    expect(transport.requestsTo('/visitor_attributes')).toHaveLength(2);

    transport.enqueue(AUTH_OK);
    await client.configure();
    await tick();

    expect(transport.requestsTo('/visitor_attributes')).toHaveLength(3);
    expect(client.userIdentifier).toBe('user-b');
    client.shutdown();
  });

  // configure() documents a failed sync as retried by the next configure();
  // that was only true for the not-yet-authenticated path.
  it('stays pending when an authenticated push is refused', async () => {
    const transport = new FakeTransport();
    const client = await authed(transport);

    transport.enqueueStatus(500);
    client.setUserIdentifier('user-a');
    await tick();
    expect(transport.requestsTo('/visitor_attributes')).toHaveLength(1);

    transport.enqueue(AUTH_OK);
    await client.configure();
    await tick();

    expect(transport.requestsTo('/visitor_attributes')).toHaveLength(2);
    client.shutdown();
  });
});

describe('a response belongs to the identity that asked for it', () => {
  beforeEach(clearBrowserStorage);

  // usable goes true again when the SDK re-authenticates, which is exactly the
  // case where the response in flight belongs to the previous visitor.
  it('drops messages fetched for a visitor the reset replaced', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();

    const messages = new MessagesService(client);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.spyOn(transport, 'send').mockImplementationOnce(async () => {
      await held;
      return {
        ok: true,
        status: 200,
        body: { notifications: [{ id: 1, title: 'A', subtitle: 'B', read: false, access_url: 'u' }] },
      };
    });

    const pending = messages.fetchMessages(1);
    client.reset();
    send.mockRestore();
    transport.enqueue(AUTH_OK);
    await client.configure();
    release();

    await expect(pending).resolves.toBeNull();
    client.shutdown();
  });
});
