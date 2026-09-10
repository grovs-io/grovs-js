import { describe, expect, it } from 'vitest';
import { ApiService } from '../../src/net/api';
import { enrich } from '../../src/events/enrich';
import { resolveConfig } from '../../src/core/config';
import { Context } from '../../src/core/context';
import { FakeTransport } from '../helpers/fake-transport';

/**
 * Golden request shapes, one per endpoint.
 *
 * The enrichment test next door asserts that required keys are *present*.
 * This asserts the exact body — every key, every name, nothing extra — which
 * is what catches a rename, a casing slip, or a field quietly added on one
 * platform and not the other.
 *
 * Expectations are written out rather than snapshotted on purpose: a snapshot
 * updated with `-u` records drift as if it were intent, which is the failure
 * mode this file exists to prevent.
 *
 * Sources reconciled here: the iOS APIService/`toBackend()` output, the
 * backend's permitted params for the SDK endpoints, and the
 * enrichment table in spec A4.
 */

function service(transport: FakeTransport, context = new Context()) {
  return new ApiService(
    resolveConfig({ apiKey: 'k' }),
    context,
    transport,
    () => 'https://app.example.com',
  );
}

const DETAILS = {
  user_agent: 'UA/1.0',
  app_version: '1.2.3',
  build: '2.0',
  screen_width: 1440,
  screen_height: 900,
  timezone: 'Europe/Bucharest',
  webgl_vendor: 'Acme',
  webgl_renderer: 'Acme GPU',
  language: 'en-GB',
  session_id: 'sess-1',
};

describe('wire contract — request bodies', () => {
  it('POST /authenticate', async () => {
    const transport = new FakeTransport();
    await service(transport).authenticate(DETAILS);

    expect(transport.last?.url).toBe('https://sdk.sqd.link/api/v1/sdk/authenticate');
    expect(transport.last?.body).toEqual({
      user_agent: 'UA/1.0',
      app_version: '1.2.3',
      build: '2.0',
      screen_width: 1440,
      screen_height: 900,
      timezone: 'Europe/Bucharest',
      webgl_vendor: 'Acme',
      webgl_renderer: 'Acme GPU',
      language: 'en-GB',
      session_id: 'sess-1',
    });
  });

  it('POST /data_for_device_and_path', async () => {
    const transport = new FakeTransport();
    await service(transport).payloadForDeviceAndPath(DETAILS, 'abc123');

    expect(transport.last?.url).toBe(
      'https://sdk.sqd.link/api/v1/sdk/data_for_device_and_path',
    );
    expect(transport.last?.body).toEqual({ ...DETAILS, path: 'abc123' });
  });

  it('POST /create_link', async () => {
    const transport = new FakeTransport();
    await service(transport).createLink({
      title: 'T',
      subtitle: 'S',
      imageURL: 'https://img',
      data: { k: 'v' },
      tags: ['a'],
      customRedirects: { ios: { link: 'https://ios', openAppIfInstalled: true } },
      showPreviewiOS: false,
      showPreviewAndroid: true,
      copyToClipboardiOS: true,
      copyToClipboardAndroid: false,
      trackingCampaign: 'C',
      trackingSource: 'S',
      trackingMedium: 'M',
    });

    expect(transport.last?.body).toEqual({
      title: 'T',
      subtitle: 'S',
      image_url: 'https://img',
      data: '{"k":"v"}',
      tags: '["a"]',
      ios_custom_redirect: '{"url":"https://ios","open_app_if_installed":true}',
      show_preview_ios: false,
      show_preview_android: true,
      copy_to_clipboard_ios: true,
      copy_to_clipboard_android: false,
      tracking_campaign: 'C',
      tracking_source: 'S',
      tracking_medium: 'M',
    });
  });

  it('POST /visitor_attributes', async () => {
    const transport = new FakeTransport();
    const context = new Context();
    context.userIdentifier = 'user-1';
    context.userAttributes = { plan: 'pro' };

    await service(transport, context).setUserAttributes();

    expect(transport.last?.body).toEqual({
      sdk_identifier: 'user-1',
      sdk_attributes: { plan: 'pro' },
    });
  });

  it('POST /events/batch — system event', async () => {
    const transport = new FakeTransport();
    await service(transport).addEvents([
      enrich({
        id: 'evt-1',
        event: 'app_open',
        createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
        sessionId: 'sess-1',
        path: 'abc123',
        engagementTime: 42,
        tags: ['launch'],
      }),
    ]);

    expect(transport.last?.url).toBe('https://sdk.sqd.link/api/v1/sdk/events/batch');
    expect(transport.last?.body).toEqual({
      events: [
        {
          event_id: 'evt-1',
          session_id: 'sess-1',
          created_at: '2026-01-01T00:00:00.000Z',
          path: 'abc123',
          engagement_time: 42,
          tags: ['launch'],
          event: 'app_open',
        },
      ],
    });
  });

  it('POST /events/batch — custom event', async () => {
    const transport = new FakeTransport();
    await service(transport).addEvents([
      enrich({
        id: 'evt-2',
        eventName: 'purchase',
        createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
        sessionId: 'sess-1',
        properties: { sku: 'x-1' },
        tags: ['checkout'],
      }),
    ]);

    expect(transport.last?.body).toEqual({
      events: [
        {
          event_id: 'evt-2',
          session_id: 'sess-1',
          created_at: '2026-01-01T00:00:00.000Z',
          tags: ['checkout'],
          event_name: 'purchase',
          properties: { sku: 'x-1' },
        },
      ],
    });
  });

  it('POST /screen_aliases', async () => {
    const transport = new FakeTransport();
    await service(transport).syncScreenAliases([{ identifier: '/c', alias: 'Checkout' }]);

    expect(transport.last?.body).toEqual({
      screen_aliases: [{ identifier: '/c', alias: 'Checkout' }],
    });
  });

  it('POST /link_details', async () => {
    const transport = new FakeTransport();
    await service(transport).linkDetails('abc123');
    expect(transport.last?.body).toEqual({ path: 'abc123' });
  });

  it('POST /add_payment_event', async () => {
    const transport = new FakeTransport();
    await service(transport).addPaymentEvent({
      event_type: 'buy',
      price_cents: 1999,
      currency: 'USD',
      product_id: 'p-1',
      date: '2026-01-01T00:00:00.000Z',
    });

    expect(transport.last?.body).toEqual({
      event_type: 'buy',
      price_cents: 1999,
      currency: 'USD',
      product_id: 'p-1',
      date: '2026-01-01T00:00:00.000Z',
    });
  });

  it('POST /notifications_for_device and /mark_notification_as_read', async () => {
    const transport = new FakeTransport();
    await service(transport).messagesForDevice(2);
    expect(transport.last?.body).toEqual({ page: 2 });

    await service(transport).markMessageAsViewed(7);
    expect(transport.last?.body).toEqual({ id: 7 });
  });

  it('GET endpoints send no body', async () => {
    const transport = new FakeTransport();
    const api = service(transport);

    await api.numberOfUnreadMessages();
    expect(transport.last?.method).toBe('GET');
    expect(transport.last?.body).toBeUndefined();

    await api.messagesForAutomaticDisplay();
    expect(transport.last?.method).toBe('GET');
    expect(transport.last?.body).toBeUndefined();
  });

  it('every request carries the same auth headers', async () => {
    const transport = new FakeTransport();
    const api = service(transport);

    await api.authenticate(DETAILS);
    await api.createLink({ title: 'T' });
    await api.addEvents([]);
    await api.numberOfUnreadMessages();

    for (const request of transport.requests) {
      expect(request.headers).toMatchObject({
        'Content-Type': 'application/json',
        PLATFORM: 'web',
        'PROJECT-KEY': 'k',
        'SDK-VERSION': '2.0',
        IDENTIFIER: 'https://app.example.com',
      });
      expect(request.headers['PROJECT_KEY']).toBeUndefined();
    }
  });
});
