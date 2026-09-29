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

  describe('removed messages inbox', () => {
    const MESSAGE = { id: 7, title: '', subtitle: '', read: false, access_url: '' };

    async function started() {
      const transport = new FakeTransport();
      transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
      const sdk = new GrovsV1('k', false, () => undefined, {
        transport,
        storage: new FakeStorage(),
      });
      await sdk.start();
      transport.requests.length = 0;
      // A failing backend must not reach the error callbacks either.
      transport.fallback = { ok: false, status: 500, body: {} };
      return { sdk, transport };
    }

    it('answers with the empty values and never calls error', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { sdk, transport } = await started();
      const messages = vi.fn();
      const count = vi.fn();
      const marked = vi.fn();
      const error = vi.fn();

      await sdk.getMessages(1, messages, error);
      await sdk.getNumberOfUnreadMessages(count, error);
      await sdk.markMessageAsRead(MESSAGE, marked, error);

      expect(messages.mock.calls).toEqual([[[]]]);
      expect(count.mock.calls).toEqual([[0]]);
      expect(marked.mock.calls).toEqual([[true]]);
      expect(error).not.toHaveBeenCalled();
      expect(transport.requests).toHaveLength(0);
    });

    it('does not throw when the callbacks are omitted', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { sdk, transport } = await started();
      // v1 integrators are untyped JavaScript, where nothing forces the arguments.
      const loose = sdk as unknown as Record<string, (...args: unknown[]) => Promise<void>>;

      await expect(loose['getMessages']!()).resolves.toBeUndefined();
      await expect(loose['getMessages']!(1)).resolves.toBeUndefined();
      await expect(loose['getNumberOfUnreadMessages']!()).resolves.toBeUndefined();
      await expect(loose['markMessageAsRead']!()).resolves.toBeUndefined();
      await expect(loose['markMessageAsRead']!(MESSAGE)).resolves.toBeUndefined();
      expect(transport.requests).toHaveLength(0);
    });

    it('showMessagesList() opens nothing and sends nothing', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      document.body.replaceChildren();
      const { sdk, transport } = await started();

      expect(sdk.showMessagesList()).toBeUndefined();
      await Promise.resolve();

      expect(document.body.childElementCount).toBe(0);
      expect(transport.requests).toHaveLength(0);
    });

    it('works before start()', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const transport = new FakeTransport();
      const sdk = new GrovsV1('k', false, () => undefined, {
        transport,
        storage: new FakeStorage(),
      });
      const messages = vi.fn();

      await sdk.getMessages(1, messages, vi.fn());

      expect(messages).toHaveBeenCalledWith([]);
      expect(transport.requests).toHaveLength(0);
    });
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
