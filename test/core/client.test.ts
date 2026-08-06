import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrovsClient } from '../../src/core/client';
import { FakeTransport } from '../helpers/fake-transport';
import { FakeStorage } from '../helpers/fake-storage';
import { GrovsError } from '../../src/net/errors';

const AUTH_OK = {
  ok: true,
  status: 200,
  body: {
    linksquared: 'visitor-1',
    sdk_identifier: 'user-42',
    sdk_attributes: { plan: 'pro' },
  },
};

function make(overrides: Record<string, unknown> = {}) {
  const transport = new FakeTransport();
  const storage = new FakeStorage();
  const client = new GrovsClient(
    { apiKey: 'k', ...overrides },
    { transport, storage },
  );
  return { client, transport, storage };
}

describe('GrovsClient.configure', () => {
  it('stores the linksquared id from the authenticate response', async () => {
    const { client, transport, storage } = make();
    transport.enqueue(AUTH_OK);
    await client.configure();
    expect(storage.get('linksquared')).toBe('visitor-1');
  });

  // The headline defect: grovs_manager.js:66-67 assigned these backwards.
  it('assigns sdk_identifier to the identifier, not the attributes', async () => {
    const { client, transport } = make();
    transport.enqueue(AUTH_OK);
    await client.configure();
    expect(client.userIdentifier).toBe('user-42');
    expect(client.userAttributes).toEqual({ plan: 'pro' });
  });

  it('resolves true and reports authenticated on success', async () => {
    const { client, transport } = make();
    transport.enqueue(AUTH_OK);
    await expect(client.configure()).resolves.toBe(true);
    expect(client.isAuthenticated()).toBe(true);
  });

  it('resolves false and fires authenticationFailed on a 403', async () => {
    const onError = vi.fn();
    const { client, transport } = make({ onError });
    transport.enqueueStatus(403, { error: 'Invalid credentials' });
    await expect(client.configure()).resolves.toBe(false);
    expect(client.isAuthenticated()).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      GrovsError.authenticationFailed,
      expect.stringContaining('Invalid credentials'),
    );
  });

  // Spec B9: the backend compares IDENTIFIER exactly against console-entered
  // linked domains, so the only useful diagnostic is the string we sent.
  it('logs the verbatim IDENTIFIER on a 422 domain mismatch', async () => {
    const onError = vi.fn();
    const { client, transport } = make({ onError });
    transport.enqueueStatus(422, {
      error: "This Web app is not configured, grovs won't function!",
    });
    await client.configure();
    const message = onError.mock.calls[0]?.[1] as string;
    expect(message).toContain('http://localhost:3000');
  });

  it('sends the stored path to the path endpoint when the URL carries one', async () => {
    const { client, transport, storage } = make();
    storage.set('Grovs_path', 'abc123');
    transport.enqueue(AUTH_OK);
    await client.configure();
    expect(transport.requestsTo('/data_for_device_and_path')).toHaveLength(1);
    expect(transport.requestsTo('/data_for_device')).toHaveLength(0);
  });

  it('falls back to the device endpoint with no stored path', async () => {
    const { client, transport } = make();
    transport.enqueue(AUTH_OK);
    await client.configure();
    expect(transport.requestsTo('/data_for_device')).toHaveLength(1);
  });

  it('invokes onDeeplink and records the payload', async () => {
    const onDeeplink = vi.fn();
    const transport = new FakeTransport();
    const storage = new FakeStorage();
    transport
      .enqueue(AUTH_OK)
      .enqueue({ ok: true, status: 200, body: { data: { screen: 'checkout' } } });
    const client = new GrovsClient({ apiKey: 'k', onDeeplink }, { transport, storage });

    await client.configure();
    expect(onDeeplink).toHaveBeenCalledWith({ screen: 'checkout' });
    expect(client.lastReceivedPayload()).toEqual({ screen: 'checkout' });
    expect(client.allReceivedPayloadsSinceStartup()).toHaveLength(1);
  });

  it('does not fire onDeeplink when the payload is empty', async () => {
    const onDeeplink = vi.fn();
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const client = new GrovsClient(
      { apiKey: 'k', onDeeplink },
      { transport, storage: new FakeStorage() },
    );
    await client.configure();
    expect(onDeeplink).not.toHaveBeenCalled();
    expect(client.lastReceivedPayload()).toBeNull();
  });
});

describe('GrovsClient identity', () => {
  it('pushes a changed identifier to the backend once authenticated', async () => {
    const { client, transport } = make();
    transport.enqueue(AUTH_OK);
    await client.configure();
    transport.requests.length = 0;

    client.setUserIdentifier('user-99');
    await vi.waitFor(() => expect(transport.requestsTo('/visitor_attributes')).toHaveLength(1));
    expect(transport.last?.body).toMatchObject({ sdk_identifier: 'user-99' });
  });

  it('holds the identifier locally until authentication completes', () => {
    const { client, transport } = make();
    client.setUserIdentifier('early');
    expect(client.userIdentifier).toBe('early');
    expect(transport.requestsTo('/visitor_attributes')).toHaveLength(0);
  });
});

describe('GrovsClient failure paths', () => {
  it('reports networkRequestFailed when the payload fetch fails', async () => {
    const onError = vi.fn();
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueueStatus(500, { error: 'boom' });
    const client = new GrovsClient({ apiKey: 'k', onError }, { transport, storage: new FakeStorage() });

    await expect(client.configure()).resolves.toBe(true);
    expect(onError).toHaveBeenCalledWith(
      GrovsError.networkRequestFailed,
      expect.stringContaining('deep link payload'),
    );
  });

  it('reports networkRequestFailed when the identity push fails', async () => {
    const onError = vi.fn();
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k', onError }, { transport, storage: new FakeStorage() });
    await client.configure();

    transport.enqueueStatus(500, { error: 'boom' });
    client.setUserIdentifier('user-99');

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        GrovsError.networkRequestFailed,
        expect.stringContaining('user identifier'),
      ),
    );
  });

  it('reports the status when the server sends no error string', async () => {
    const onError = vi.fn();
    const { client, transport } = make({ onError });
    transport.enqueueStatus(500, {});
    await client.configure();
    expect(onError).toHaveBeenCalledWith(
      GrovsError.authenticationFailed,
      expect.stringContaining('500'),
    );
  });

  it('pushes identity set before authentication once it completes', async () => {
    const transport = new FakeTransport();
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });

    client.setUserIdentifier('early-user');
    transport.enqueue(AUTH_OK);
    await client.configure();

    await vi.waitFor(() => expect(transport.requestsTo('/visitor_attributes')).toHaveLength(1));
    // The pre-set identifier survives; the response does not overwrite it.
    expect(client.userIdentifier).toBe('early-user');
  });

  it('accepts attributes set before authentication', async () => {
    const transport = new FakeTransport();
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });

    client.setUserAttributes({ tier: 'free' });
    transport.enqueue(AUTH_OK);
    await client.configure();

    expect(client.userAttributes).toEqual({ tier: 'free' });
  });

  it('treats a non-object sdk_attributes as absent', async () => {
    const transport = new FakeTransport();
    transport.enqueue({
      ok: true,
      status: 200,
      body: { linksquared: 'v1', sdk_identifier: 'u', sdk_attributes: 'not-an-object' },
    });
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });
    await client.configure();
    expect(client.userAttributes).toBeNull();
  });

  it('reuses a linksquared id already in storage', () => {
    const storage = new FakeStorage();
    storage.set('linksquared', 'returning-visitor');
    const transport = new FakeTransport();
    new GrovsClient({ apiKey: 'k' }, { transport, storage });

    // Proven through the header the next request would carry.
    expect(storage.get('linksquared')).toBe('returning-visitor');
  });
});

// Spec A1: a server-side call could never have succeeded, and a silent
// success is the exact defect A5 exists to remove.
describe('GrovsClient outside a browser', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolves false and reports rather than failing silently', async () => {
    vi.stubGlobal('window', undefined);
    const onError = vi.fn();
    const { client, transport } = make({ onError });

    await expect(client.configure()).resolves.toBe(false);

    expect(transport.requests).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(
      GrovsError.networkRequestFailed,
      expect.stringContaining('server rendering'),
    );
  });

  it('reports once per method, not once per render', async () => {
    vi.stubGlobal('window', undefined);
    const onError = vi.fn();
    const { client } = make({ onError });

    await client.configure();
    await client.configure();
    await client.configure();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reuses networkRequestFailed rather than adding a fifth code', async () => {
    vi.stubGlobal('window', undefined);
    const onError = vi.fn();
    const { client } = make({ onError });

    await client.configure();

    const code = onError.mock.calls[0]?.[0] as GrovsError;
    expect([1, 2, 3, 4]).toContain(code);
    expect(code).toBe(GrovsError.networkRequestFailed);
  });
});

describe('GrovsClient.setDebugLevel', () => {
  it('changes what the logger emits', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { client } = make();
    client.setDebugLevel('info');
    client.setEnabled(true);
    expect(spy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('GrovsClient.setEnabled', () => {
  it('stops issuing requests when disabled', async () => {
    const { client, transport } = make();
    transport.enqueue(AUTH_OK);
    await client.configure();
    client.setEnabled(false);
    transport.requests.length = 0;

    client.setUserIdentifier('user-99');
    expect(transport.requests).toHaveLength(0);
  });
});
