import { beforeEach, describe, expect, it } from 'vitest';
import { GrovsClient } from '../../src/core/client';
import { FakeTransport } from '../helpers/fake-transport';

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

describe('consent', () => {
  beforeEach(clearBrowserStorage);

  // The default must preserve v1 behaviour: an integrator who upgrades
  // without reading the changelog must not silently lose every event.
  it('tracks immediately when requireConsent is absent', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });

    await expect(client.configure()).resolves.toBe(true);
    expect(transport.requestsTo('/authenticate')).toHaveLength(1);
    client.shutdown();
  });

  it('sends nothing and stores nothing until consent is granted', async () => {
    const transport = new FakeTransport();
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );

    await expect(client.configure()).resolves.toBe(false);
    client.track('early-event');

    expect(transport.requests).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    expect(document.cookie).not.toContain('linksquared');
    client.shutdown();
  });

  it('authenticates on grantConsent', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();

    await expect(client.grantConsent()).resolves.toBe(true);
    expect(transport.requestsTo('/authenticate')).toHaveLength(1);
    client.shutdown();
  });

  // A banner answered thirty seconds late should not cost the whole visit.
  it('keeps events tracked before consent and sends them after', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();

    client.track('before-consent');
    await client.grantConsent();
    client.eventsHandler.onPathResolved(null);
    await client.flush();

    const batch = transport.requestsTo('/events/batch')[0];
    const events = (batch?.body as { events: Record<string, unknown>[] }).events;
    expect(events.some((e) => e['event_name'] === 'before-consent')).toBe(true);
    client.shutdown();
  });

  it('persists to durable storage once consent is granted', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();
    await client.grantConsent();

    expect(document.cookie + localStorage.getItem('linksquared')).toContain('v1');
    client.shutdown();
  });

  it('is idempotent', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();
    await client.grantConsent();
    await client.grantConsent();

    expect(transport.requestsTo('/authenticate')).toHaveLength(1);
    client.shutdown();
  });
});

describe('reset', () => {
  beforeEach(clearBrowserStorage);

  it('clears stored identifiers, session and queue', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();
    client.track('x');

    client.reset();

    expect(client.isAuthenticated()).toBe(false);
    expect(client.userIdentifier).toBeNull();
    expect(localStorage.getItem('linksquared')).toBeNull();
    expect(document.cookie).not.toContain('linksquared');
  });

  it('mints a new session after reset', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();

    const before = client.sessionManager.currentSessionId();
    client.reset();
    expect(client.sessionManager.currentSessionId()).not.toBe(before);
  });
});
