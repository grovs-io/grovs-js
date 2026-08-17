import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GrovsV1, __resetDeprecationWarnings } from '../../src/compat/v1';
import { FakeTransport } from '../helpers/fake-transport';
import { FakeStorage } from '../helpers/fake-storage';

const AUTH_OK = {
  ok: true,
  status: 200,
  body: { linksquared: 'v1', sdk_identifier: 'user-1', sdk_attributes: { a: 1 } },
};

describe('GrovsV1 compatibility shim', () => {
  beforeEach(() => {
    __resetDeprecationWarnings();
    vi.restoreAllMocks();
  });

  it('authenticates through start() and invokes the callback', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const onAuth = vi.fn();

    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start(onAuth);

    expect(onAuth).toHaveBeenCalledOnce();
    expect(sdk.authenticated()).toBe(true);
  });

  it('routes the deep link payload to the constructor callback', async () => {
    const transport = new FakeTransport();
    transport
      .enqueue(AUTH_OK)
      .enqueue({ ok: true, status: 200, body: { data: { screen: 'home' } } });
    const handler = vi.fn();

    const sdk = new GrovsV1('k', false, handler, { transport, storage: new FakeStorage() });
    await sdk.start();

    expect(handler).toHaveBeenCalledWith({ screen: 'home' });
  });

  it('calls the success callback of createLink', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start();
    transport.enqueue({ ok: true, status: 200, body: { link: 'https://sqd.link/x' } });

    const success = vi.fn();
    const error = vi.fn();
    await sdk.createLink('T', 'S', 'img', { k: 'v' }, success, error);

    expect(success).toHaveBeenCalledWith('https://sqd.link/x');
    expect(error).not.toHaveBeenCalled();
  });

  it('calls the error callback of createLink exactly once on failure', async () => {
    const transport = new FakeTransport();
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });

    const success = vi.fn();
    const error = vi.fn();
    await sdk.createLink('T', 'S', 'img', {}, success, error);

    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it('warns once per deprecated method, not once per call', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport: new FakeTransport(),
      storage: new FakeStorage(),
    });

    sdk.userIdentifier();
    sdk.userIdentifier();
    sdk.userIdentifier();

    const identifierWarnings = spy.mock.calls.filter((c) =>
      String(c[0]).includes('userIdentifier'),
    );
    expect(identifierWarnings).toHaveLength(1);
  });

  it('names the v2 replacement in the deprecation warning', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport: new FakeTransport(),
      storage: new FakeStorage(),
    });

    sdk.getAllReceivedData();

    expect(String(spy.mock.calls[0]?.[0])).toContain('allReceivedPayloadsSinceStartup');
  });

  // The corrected-values case from the Migration section: v1 returned these
  // swapped, and anyone who compensated needs to know.
  it('returns the identifier from userIdentifier(), not the attributes', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start();

    expect(sdk.userIdentifier()).toBe('user-1');
    expect(sdk.userAttributes()).toEqual({ a: 1 });
  });

  it('prefixes the api key for the test environment', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const sdk = new GrovsV1('k', true, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start();

    expect(transport.requests[0]?.headers['PROJECT-KEY']).toBe('test_k');
  });

  it('forwards setUserIdentifier and setUserAttributes', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start();

    sdk.setUserIdentifier('changed');
    sdk.setUserAttributes({ b: 2 });

    expect(sdk.userIdentifier()).toBe('changed');
    expect(sdk.userAttributes()).toEqual({ b: 2 });
  });

  it('reports messages through the v1 callback shape', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start();

    transport.enqueue({
      ok: true,
      status: 200,
      body: { notifications: [{ id: 1, title: 'A', subtitle: '', read: false, access_url: 'u' }] },
    });
    const response = vi.fn();
    await sdk.getMessages(1, response, vi.fn());
    expect(response).toHaveBeenCalledWith([
      { id: 1, title: 'A', subtitle: '', read: false, access_url: 'u' },
    ]);

    transport.enqueue({ ok: true, status: 200, body: { number_of_unread_notifications: 3 } });
    const countResponse = vi.fn();
    await sdk.getNumberOfUnreadMessages(countResponse, vi.fn());
    expect(countResponse).toHaveBeenCalledWith(3);
  });

  it('marks a message as read through the v1 callback shape', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start();

    transport.enqueue({ ok: true, status: 200, body: {} });
    const ok = vi.fn();
    const err = vi.fn();
    await sdk.markMessageAsRead(
      { id: 7, title: '', subtitle: '', read: false, access_url: '' },
      ok,
      err,
    );
    expect(ok).toHaveBeenCalledWith(true);
    expect(err).not.toHaveBeenCalled();
  });

  // The error callbacks v1 integrators wired to retry logic and error UI.
  it('calls the error callback when message fetching fails', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start();

    transport.enqueueStatus(500, {});
    const response = vi.fn();
    const error = vi.fn();
    await sdk.getMessages(1, response, error);

    expect(response).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it('calls the error callback when the unread count fails', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start();

    transport.enqueueStatus(500, {});
    const response = vi.fn();
    const error = vi.fn();
    await sdk.getNumberOfUnreadMessages(response, error);

    expect(response).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it('calls the error callback when marking read fails', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start();

    transport.enqueueStatus(500, {});
    const response = vi.fn();
    const error = vi.fn();
    await sdk.markMessageAsRead(
      { id: 1, title: '', subtitle: '', read: false, access_url: '' },
      response,
      error,
    );

    expect(response).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it('does not invoke the auth callback when authentication fails', async () => {
    const transport = new FakeTransport();
    transport.enqueueStatus(403, { error: 'Invalid credentials' });
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });

    const onAuth = vi.fn();
    await sdk.start(onAuth);

    expect(onAuth).not.toHaveBeenCalled();
    expect(sdk.authenticated()).toBe(false);
  });

  it('opens the messages list through the v1 method', async () => {
    document.body.replaceChildren();
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start();

    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });
    sdk.showMessagesList();

    await vi.waitFor(() => expect(document.getElementById('Grovs-modal')).not.toBeNull());
  });

  it('returns received payloads through getAllReceivedData', async () => {
    const transport = new FakeTransport();
    transport
      .enqueue(AUTH_OK)
      .enqueue({ ok: true, status: 200, body: { data: { screen: 'home' } } });
    const sdk = new GrovsV1('k', false, () => undefined, {
      transport,
      storage: new FakeStorage(),
    });
    await sdk.start();

    expect(sdk.getAllReceivedData()).toEqual([{ screen: 'home' }]);
  });
});
