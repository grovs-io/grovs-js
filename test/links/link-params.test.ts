import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../src/net/api';
import { LinkGenerator } from '../../src/links/links';
import { PaymentEventsHandler } from '../../src/events/payment-events-handler';
import { MessagesService } from '../../src/messages/messages';
import { MessagesUI } from '../../src/messages/messages-ui';
import { GrovsClient } from '../../src/core/client';
import { resolveConfig } from '../../src/core/config';
import { Context } from '../../src/core/context';
import { Logger } from '../../src/logging/logger';
import { GrovsError } from '../../src/net/errors';
import { FakeTransport } from '../helpers/fake-transport';
import { FakeStorage } from '../helpers/fake-storage';

const AUTH_OK = {
  ok: true,
  status: 200,
  body: { linksquared: 'v1', sdk_identifier: null, sdk_attributes: null },
};

function api(transport: FakeTransport) {
  return new ApiService(resolveConfig({ apiKey: 'k' }), new Context(), transport, () => 'https://x');
}

async function authedClient(transport: FakeTransport, onError?: () => void) {
  transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
  const client = new GrovsClient(
    { apiKey: 'k', ...(onError ? { onError } : {}) },
    { transport, storage: new FakeStorage(), autoStartEvents: false },
  );
  await client.configure();
  return client;
}

describe('createLink full parameter surface', () => {
  it('sends the full parameter surface', async () => {
    const transport = new FakeTransport();
    await api(transport).createLink({
      title: 'T',
      subtitle: 'S',
      imageURL: 'https://img',
      data: { k: 'v' },
      tags: ['a', 'b'],
      customRedirects: {
        ios: { link: 'https://ios', openAppIfInstalled: true },
        android: { link: 'https://android' },
        desktop: { link: 'https://web' },
      },
      showPreviewiOS: false,
      showPreviewAndroid: true,
      copyToClipboardiOS: true,
      copyToClipboardAndroid: false,
      trackingCampaign: 'BlackFriday2025',
      trackingSource: 'instagram',
      trackingMedium: 'social',
    });

    const body = transport.last?.body as Record<string, unknown>;
    expect(body['title']).toBe('T');
    expect(body['subtitle']).toBe('S');
    expect(body['image_url']).toBe('https://img');
    expect(body['data']).toBe('{"k":"v"}');
    expect(body['tags']).toBe('["a","b"]');
    expect(body['show_preview_ios']).toBe(false);
    expect(body['show_preview_android']).toBe(true);
    expect(body['copy_to_clipboard_ios']).toBe(true);
    expect(body['copy_to_clipboard_android']).toBe(false);
    expect(body['tracking_campaign']).toBe('BlackFriday2025');
    expect(body['tracking_source']).toBe('instagram');
    expect(body['tracking_medium']).toBe('social');
  });

  // One param per platform, {url, open_app_if_installed} — matching iOS's
  // APIService and the backend's CustomRedirectsHandler, which reads only
  // ios/android/desktop_custom_redirect and drops phone entries that omit
  // open_app_if_installed.
  it('sends one custom redirect param per platform in the backend shape', async () => {
    const transport = new FakeTransport();
    await api(transport).createLink({
      customRedirects: {
        ios: { link: 'https://ios', openAppIfInstalled: true },
        android: { link: 'https://android' },
        desktop: { link: 'https://web' },
      },
    });

    const body = transport.last?.body as Record<string, string>;
    expect(JSON.parse(body['ios_custom_redirect'] ?? '{}')).toEqual({
      url: 'https://ios',
      open_app_if_installed: true,
    });
    expect(JSON.parse(body['android_custom_redirect'] ?? '{}')).toEqual({
      url: 'https://android',
      open_app_if_installed: false,
    });
    expect(JSON.parse(body['desktop_custom_redirect'] ?? '{}')).toEqual({
      url: 'https://web',
    });
    expect(body['custom_redirects']).toBeUndefined();
  });

  // `false` is a meaningful override; omitting it is not the same thing.
  it('sends showPreview flags when explicitly false', async () => {
    const transport = new FakeTransport();
    await api(transport).createLink({ showPreviewiOS: false });
    expect((transport.last?.body as Record<string, unknown>)['show_preview_ios']).toBe(false);
  });

  // The backend reads an absent key as "inherit the project default", so
  // defaulting these to false would silently override the project setting.
  it('omits the clipboard params entirely when unset', async () => {
    const transport = new FakeTransport();
    await api(transport).createLink({ title: 'T', showPreviewiOS: true });

    const body = transport.last?.body as Record<string, unknown>;
    expect('copy_to_clipboard_ios' in body).toBe(false);
    expect('copy_to_clipboard_android' in body).toBe(false);
  });

  it('sends clipboard flags when explicitly false', async () => {
    const transport = new FakeTransport();
    await api(transport).createLink({ copyToClipboardiOS: false, copyToClipboardAndroid: false });

    const body = transport.last?.body as Record<string, unknown>;
    expect(body['copy_to_clipboard_ios']).toBe(false);
    expect(body['copy_to_clipboard_android']).toBe(false);
  });

  it('omits everything absent', async () => {
    const transport = new FakeTransport();
    await api(transport).createLink({ title: 'T' });
    expect(transport.last?.body).toEqual({ title: 'T' });
  });

  it('omits an empty tags array', async () => {
    const transport = new FakeTransport();
    await api(transport).createLink({ title: 'T', tags: [] });
    expect(transport.last?.body).toEqual({ title: 'T' });
  });
});

describe('linkDetails', () => {
  it('returns the link details object', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { path: 'abc', title: 'T' } });

    const details = await new LinkGenerator(client).linkDetails('abc');
    expect(details).toEqual({ path: 'abc', title: 'T' });
    expect(transport.last?.body).toEqual({ path: 'abc' });
  });

  // Tri-state: true / false / null, where null means the link inherits the
  // project default. The body is passed through untyped, so nulls survive.
  it('passes the clipboard flags through, null included', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({
      ok: true,
      status: 200,
      body: { path: 'abc', copy_to_clipboard_ios: true, copy_to_clipboard_android: null },
    });

    const details = await new LinkGenerator(client).linkDetails('abc');
    expect(details).toEqual({
      path: 'abc',
      copy_to_clipboard_ios: true,
      copy_to_clipboard_android: null,
    });
  });

  // The backend answers null with a 200 for an unknown path, so absent is not
  // an error.
  it('returns null for an unknown path without reporting an error', async () => {
    const onError = vi.fn();
    const transport = new FakeTransport();
    const client = await authedClient(transport, onError);
    transport.enqueue({ ok: true, status: 200, body: null });

    await expect(new LinkGenerator(client).linkDetails('nope')).resolves.toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a transport failure', async () => {
    const onError = vi.fn();
    const transport = new FakeTransport();
    const client = await authedClient(transport, onError);
    transport.enqueueStatus(500);

    await expect(new LinkGenerator(client).linkDetails('abc')).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(GrovsError.networkRequestFailed, expect.any(String));
  });

  it('returns null when unauthenticated', async () => {
    const transport = new FakeTransport();
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });
    await expect(new LinkGenerator(client).linkDetails('abc')).resolves.toBeNull();
    expect(transport.requestsTo('/link_details')).toHaveLength(0);
  });
});

describe('PaymentEventsHandler', () => {
  it('sends a custom purchase', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: {} });

    const ok = await new PaymentEventsHandler(client).logCustomPurchase({
      type: 'buy',
      priceInCents: 1999,
      currency: 'USD',
      productID: 'com.acme.coins.100',
      startDate: new Date('2026-01-01T00:00:00Z'),
    });

    expect(ok).toBe(true);
    // Wire names must match iOS's TransactionData.toData() and the backend's
    // permit list (event_type / price_cents / date), or Rails drops them.
    expect(transport.last?.body).toEqual({
      transaction_id: expect.any(String),
      event_type: 'buy',
      price_cents: 1999,
      currency: 'USD',
      product_id: 'com.acme.coins.100',
      date: '2026-01-01T00:00:00.000Z',
    });
  });

  it('defaults the start date to now', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: {} });

    await new PaymentEventsHandler(client).logCustomPurchase({
      type: 'refund',
      priceInCents: 100,
      currency: 'EUR',
      productID: 'p',
    });

    expect((transport.last?.body as Record<string, string>)['date']).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  // Spec B4: routes.rb mounts the endpoint only when GROVS_EE=true, so on a
  // standard deployment it 404s. Retrying forever against a route that will
  // never exist is the failure mode worth naming.
  it('reports the Enterprise requirement on a 404 and issues exactly one request', async () => {
    const onError = vi.fn();
    const transport = new FakeTransport();
    const client = await authedClient(transport, onError);
    transport.enqueueStatus(404, {});

    const ok = await new PaymentEventsHandler(client).logCustomPurchase({
      type: 'buy',
      priceInCents: 1,
      currency: 'USD',
      productID: 'p',
    });

    expect(ok).toBe(false);
    expect(transport.requestsTo('/add_payment_event')).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(
      GrovsError.eventDispatchFailed,
      expect.stringContaining('GROVS_EE'),
    );
  });

  it('reports a generic failure without naming Enterprise', async () => {
    const onError = vi.fn();
    const transport = new FakeTransport();
    const client = await authedClient(transport, onError);
    transport.enqueueStatus(500, {});

    await new PaymentEventsHandler(client).logCustomPurchase({
      type: 'buy',
      priceInCents: 1,
      currency: 'USD',
      productID: 'p',
    });

    expect(String(onError.mock.calls[0]?.[1])).not.toContain('GROVS_EE');
  });

  it('refuses when unauthenticated', async () => {
    const transport = new FakeTransport();
    const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });

    const ok = await new PaymentEventsHandler(client).logCustomPurchase({
      type: 'buy',
      priceInCents: 1,
      currency: 'USD',
      productID: 'p',
    });

    expect(ok).toBe(false);
    expect(transport.requestsTo('/add_payment_event')).toHaveLength(0);
  });
});

describe('MessagesUI shadow isolation and automatic display', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  // v1 injected a raw HTML string into the host page, so host CSS leaked in
  // and the modal's own styles leaked out.
  it('renders into a shadow root, invisible to host-document queries', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({
      ok: true,
      status: 200,
      body: { notifications: [{ id: 1, title: 'A', subtitle: '', read: false, access_url: 'u' }] },
    });

    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    await ui.showMessagesList();

    expect(document.querySelectorAll('.grovs-item')).toHaveLength(0);
    const root = document.getElementById('Grovs-modal')?.shadowRoot;
    expect(root?.querySelectorAll('.grovs-item')).toHaveLength(1);
  });

  it('does not load a third-party font', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });

    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    await ui.showMessagesList();

    const root = document.getElementById('Grovs-modal')?.shadowRoot;
    expect(root?.querySelector('link[href*="fonts.googleapis.com"]')).toBeNull();
    expect(document.querySelector('link[href*="fonts.googleapis.com"]')).toBeNull();
  });

  // v1 implemented this and commented the body out.
  it('opens each automatic-display message', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({
      ok: true,
      status: 200,
      body: {
        notifications: [
          { id: 1, title: 'Auto A', subtitle: '', read: false, access_url: 'https://a' },
        ],
      },
    });

    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    await ui.displayAutomaticMessages();

    expect(document.querySelector('.grovs-page-modal')).not.toBeNull();
  });

  it('opens nothing when there are no automatic messages', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });

    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    await ui.displayAutomaticMessages();

    expect(document.querySelector('.grovs-page-modal')).toBeNull();
  });
});
