import { beforeEach, describe, expect, it } from 'vitest';
import { GrovsClient } from '../../src/core/client';
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
