import { describe, expect, it } from 'vitest';
import { ApiService } from '../../src/net/api';
import { resolveConfig } from '../../src/core/config';
import { Context } from '../../src/core/context';
import { FakeTransport } from '../helpers/fake-transport';

const DETAILS = { user_agent: 'UA', app_version: '0', build: '0' };

function makeService(transport = new FakeTransport()) {
  const api = new ApiService(
    resolveConfig({ apiKey: 'k' }),
    new Context(),
    transport,
    () => 'https://app.example.com',
  );
  return { api, transport };
}

describe('ApiService', () => {
  it('posts device details to /authenticate', async () => {
    const { api, transport } = makeService();
    await api.authenticate(DETAILS);
    expect(transport.last?.url).toBe('https://sdk.sqd.link/api/v1/sdk/authenticate');
    expect(transport.last?.method).toBe('POST');
    expect(transport.last?.body).toEqual(DETAILS);
  });

  it('uses /data_for_device_and_path, not _and_url (spec B1)', async () => {
    const { api, transport } = makeService();
    await api.payloadForDeviceAndPath(DETAILS, 'abc123');
    expect(transport.last?.url).toBe(
      'https://sdk.sqd.link/api/v1/sdk/data_for_device_and_path',
    );
    expect(transport.last?.body).toEqual({ ...DETAILS, path: 'abc123' });
  });

  it('serialises link data as a JSON string and omits absent fields', async () => {
    const { api, transport } = makeService();
    await api.createLink({ title: 'T', data: { k: 'v' } });
    expect(transport.last?.body).toEqual({ title: 'T', data: '{"k":"v"}' });
  });

  it('sends the identifier and attributes to /visitor_attributes', async () => {
    const transport = new FakeTransport();
    const context = new Context();
    context.userIdentifier = 'user-1';
    context.userAttributes = { plan: 'pro' };
    const api = new ApiService(
      resolveConfig({ apiKey: 'k' }),
      context,
      transport,
      () => 'https://app.example.com',
    );

    await api.setUserAttributes();
    expect(transport.last?.body).toEqual({
      sdk_identifier: 'user-1',
      sdk_attributes: { plan: 'pro' },
    });
  });

  it('fetches unread count over GET with no body', async () => {
    const { api, transport } = makeService();
    await api.numberOfUnreadMessages();
    expect(transport.last?.method).toBe('GET');
    expect(transport.last?.url).toBe(
      'https://sdk.sqd.link/api/v1/sdk/number_of_unread_notifications',
    );
    expect(transport.last?.body).toBeUndefined();
  });

  it('marks a message read by id', async () => {
    const { api, transport } = makeService();
    await api.markMessageAsViewed(42);
    expect(transport.last?.body).toEqual({ id: 42 });
  });

  it('attaches auth headers to every request', async () => {
    const { api, transport } = makeService();
    await api.authenticate(DETAILS);
    expect(transport.last?.headers['PROJECT-KEY']).toBe('k');
    expect(transport.last?.headers['PLATFORM']).toBe('web');
  });
});
