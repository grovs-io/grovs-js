import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GrovsClient, __resetPendingConsentStore } from '../../src/core/client';
import { MessagesService } from '../../src/messages/messages';
import { PersistedQueue } from '../../src/storage/persisted-queue';
import { FakeTransport } from '../helpers/fake-transport';
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
      'grovs_events',
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
      'grovs_events',
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

    const frame = document.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame?.getAttribute('src')).toBe('about:blank');
    client.shutdown();
  });
});
