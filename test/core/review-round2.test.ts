import { describe, expect, it } from 'vitest';
import { GrovsClient } from '../../src/core/client';
import { FakeTransport } from '../helpers/fake-transport';
import { FakeStorage } from '../helpers/fake-storage';
import { FakeClock } from '../helpers/fake-clock';
import { QUEUE_STORAGE_KEY } from '../../src/storage/persisted-queue';
import type { QueuedEvent } from '../../src/events/event';
import { scopedKey } from '../../src/storage/scoped-storage';

const AUTH_EXISTING = {
  ok: true,
  status: 200,
  body: { linksquared: 'v1', sdk_identifier: 'existing-user', sdk_attributes: { plan: 'pro' } },
};
const PAYLOAD_NONE = { ok: true, status: 200, body: { data: null } };

function make(overrides: Record<string, unknown> = {}) {
  const transport = new FakeTransport();
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const client = new GrovsClient(
    { apiKey: 'k', ...overrides },
    { transport, storage, clock, autoStartEvents: false },
  );
  return { client, transport, storage, clock };
}

describe('identity fields are tracked independently', () => {
  it('setUserAttributes() before authentication keeps the server identifier', async () => {
    const { client, transport } = make();
    transport.enqueue(AUTH_EXISTING).enqueue(PAYLOAD_NONE);
    client.setUserAttributes({ tier: 'gold' });
    await client.configure();

    expect(client.userIdentifier).toBe('existing-user');
    expect(client.userAttributes).toEqual({ tier: 'gold' });
    const push = transport.requestsTo('/visitor_attributes')[0];
    expect(push?.body).toEqual({ sdk_identifier: 'existing-user', sdk_attributes: { tier: 'gold' } });
  });

  it('setUserIdentifier() before authentication keeps the server attributes', async () => {
    const { client, transport } = make();
    transport.enqueue(AUTH_EXISTING).enqueue(PAYLOAD_NONE);
    client.setUserIdentifier('new-user');
    await client.configure();

    expect(client.userIdentifier).toBe('new-user');
    expect(client.userAttributes).toEqual({ plan: 'pro' });
  });

  it('setUserIdentifier(null) before authentication is still an instruction to clear', async () => {
    const { client, transport } = make();
    transport.enqueue(AUTH_EXISTING).enqueue(PAYLOAD_NONE);
    client.setUserIdentifier(null);
    await client.configure();

    expect(client.userIdentifier).toBeNull();
    const push = transport.requestsTo('/visitor_attributes')[0];
    expect(push?.body).toMatchObject({ sdk_identifier: null });
  });
});

describe('setEnabled(false) is enforced everywhere', () => {
  it('setScreenAliases() does not send while disabled, and syncs on re-enable', async () => {
    const { client, transport } = make();
    transport.enqueue(AUTH_EXISTING).enqueue(PAYLOAD_NONE);
    await client.configure();
    client.setEnabled(false);
    const before = transport.requestsTo('/screen_aliases').length;

    client.setScreenAliases({ '/a': 'A' });
    expect(transport.requestsTo('/screen_aliases')).toHaveLength(before);

    client.setEnabled(true);
    await Promise.resolve();
    expect(transport.requestsTo('/screen_aliases')).toHaveLength(before + 1);
  });

  it('an older sync succeeding does not clear a newer pending map', async () => {
    const { client, transport } = make();
    transport.enqueue(AUTH_EXISTING).enqueue(PAYLOAD_NONE);
    await client.configure();

    let release!: (response: { ok: boolean; status: number; body: unknown }) => void;
    transport.hold = new Promise((resolve) => {
      release = resolve;
    });
    client.setScreenAliases({ '/a': 'A' });
    client.setEnabled(false);
    client.setScreenAliases({ '/b': 'B' });
    release({ ok: true, status: 200, body: {} });
    transport.hold = null;
    await new Promise((resolve) => setTimeout(resolve, 0));

    client.setEnabled(true);
    await Promise.resolve();
    const last = transport.requestsTo('/screen_aliases').pop();
    expect(last?.body).toEqual({ screen_aliases: [{ identifier: '/b', alias: 'B' }] });
  });
});

describe('legacy unscoped state', () => {
  it('carries the launch counters in and drops the ownerless queue', async () => {
    localStorage.clear();
    localStorage.setItem('grovs_opens', '5');
    localStorage.setItem(
      'grovs_events',
      JSON.stringify([{ id: 'old', createdAt: Date.now(), event: 'app_open', sessionId: 's' }]),
    );
    const transport = new FakeTransport();
    transport.enqueue({ ok: true, status: 200, body: { linksquared: 'v1' } });
    transport.enqueue(PAYLOAD_NONE);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();

    expect(localStorage.getItem('grovs_opens')).toBeNull();
    expect(localStorage.getItem('grovs_events')).toBeNull();
    expect(localStorage.getItem(scopedKey('grovs_opens', 'k'))).toBe('5');
    expect(localStorage.getItem(scopedKey('grovs_events', 'k'))).toBeNull();
    client.dispose();
    localStorage.clear();
  });

  it('keeps the legacy key when the copy is refused', () => {
    localStorage.clear();
    localStorage.setItem('grovs_opens', '5');
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      new GrovsClient({ apiKey: 'k' }, { transport: new FakeTransport() }).dispose();
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(localStorage.getItem('grovs_opens')).toBe('5');
    localStorage.clear();
  });
});

/** The queue as persisted, read the way a reload would. */
function stored(client: GrovsClient, storage: FakeStorage): QueuedEvent[] {
  client.shutdown();
  return JSON.parse(storage.get(QUEUE_STORAGE_KEY) ?? '[]') as QueuedEvent[];
}

describe('global tags reach system events', () => {
  it('stamps time_spent with the global tags', () => {
    const { client, storage } = make();
    client.setGlobalTags(['beta']);
    client.eventsHandler.log('time_spent', 12);
    expect(stored(client, storage)[0]?.tags).toEqual(['beta']);
  });
});

describe('reset() clears the screen context', () => {
  it('a custom event after reset carries no previous screen', async () => {
    const { client, transport, storage } = make();
    transport.enqueue(AUTH_EXISTING).enqueue(PAYLOAD_NONE);
    await client.configure();
    client.trackScreenView('Private Account');
    client.reset();
    transport.enqueue(AUTH_EXISTING).enqueue(PAYLOAD_NONE);
    await client.configure();
    client.track('signup');

    const signup = stored(client, storage).find((event) => event.eventName === 'signup');
    expect(signup?.properties).toBeUndefined();
  });
});



describe('stored state is scoped per project', () => {
  it('a second project on the same origin does not send the first one\'s queue', async () => {
    localStorage.clear();
    const auth = { ok: true, status: 200, body: { linksquared: 'v1' } };
    const payload = { ok: true, status: 200, body: { data: null } };

    const a = new FakeTransport();
    a.enqueue(auth).enqueue(payload);
    const first = new GrovsClient({ apiKey: 'project-a' }, { transport: a, autoStartEvents: false });
    await first.configure();
    first.track('from_a');
    first.dispose();
    expect(localStorage.getItem(scopedKey('grovs_events', 'project-a'))).toContain('from_a');

    const b = new FakeTransport();
    b.enqueue(auth).enqueue(payload);
    const second = new GrovsClient({ apiKey: 'project-b' }, { transport: b, autoStartEvents: false });
    await second.configure();
    second.eventsHandler.onPathResolved(null);
    await second.flush();
    const sent = b.requestsTo('/events/batch').flatMap(
      (r) => (r.body as { events: Record<string, unknown>[] }).events,
    );
    expect(sent.map((e) => e['event_name'])).not.toContain('from_a');
    second.dispose();
    localStorage.clear();
  });

  it('test and production of one project keep separate queues', async () => {
    localStorage.clear();
    const auth = { ok: true, status: 200, body: { linksquared: 'v1' } };
    const payload = { ok: true, status: 200, body: { data: null } };
    const t = new FakeTransport();
    t.enqueue(auth).enqueue(payload);
    const test = new GrovsClient(
      { apiKey: 'p', testEnvironment: true },
      { transport: t, autoStartEvents: false },
    );
    await test.configure();
    test.track('from_test');
    test.dispose();
    expect(localStorage.getItem(scopedKey('grovs_events', 'test_p'))).toContain('from_test');
    expect(localStorage.getItem(scopedKey('grovs_events', 'p'))).toBeNull();
    localStorage.clear();
  });
});
