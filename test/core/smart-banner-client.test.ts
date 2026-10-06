import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GrovsClient } from '../../src/core/client';
import { HOST_ID } from '../../src/smartBanner/view';
import { DISMISSED_KEY } from '../../src/smartBanner/store';
import { HoldingTransport, RAW_BANNER, deferred } from '../smartBanner/fixtures';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const auth = (has: boolean) => ({
  ok: true,
  status: 200,
  body: { linksquared: 'v1', sdk_identifier: null, sdk_attributes: null, has_smart_banners: has },
});
const LIST = { ok: true, status: 200, body: { smart_banners: [RAW_BANNER] } };

async function settle(ms = 32): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function transportFor(has = true): HoldingTransport {
  const transport = new HoldingTransport();
  transport.enqueue(auth(has)).enqueue(LIST);
  return transport;
}

describe('smart banner in the client', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = '';
    history.replaceState({}, '', '/');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
  });

  it('shows after configure when the project has banners', async () => {
    const transport = transportFor();
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();
    await settle();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    client.dispose();
  });

  it('never asks for banners when the project has none', async () => {
    const transport = transportFor(false);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();
    await settle();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(0);
    client.dispose();
  });

  it('respects smartBanner: false', async () => {
    const transport = transportFor();
    const client = new GrovsClient({ apiKey: 'k', smartBanner: false }, { transport, autoStartEvents: false });
    await client.configure();
    await settle();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(0);
    client.dispose();
  });

  it('fetches, stores and shows nothing until consent, then shows', async () => {
    const transport = transportFor();
    const client = new GrovsClient({ apiKey: 'k', requireConsent: true }, { transport, autoStartEvents: false });
    await client.configure();
    await settle();
    expect(transport.requests).toHaveLength(0);
    expect(document.getElementById(HOST_ID)).toBeNull();
    expect(Object.keys(sessionStorage)).toHaveLength(0);

    await client.grantConsent();
    await settle();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    client.dispose();
  });

  it('setEnabled(false) removes a shown banner; true brings it back', async () => {
    const transport = transportFor();
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();
    await settle();
    client.setEnabled(false);
    expect(document.getElementById(HOST_ID)).toBeNull();
    client.setEnabled(true);
    await settle();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    client.dispose();
  });

  it('reset() removes the banner and clears its dismissals and caches', async () => {
    const transport = transportFor();
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();
    await settle();
    (document.getElementById(HOST_ID)!.shadowRoot!.querySelector('button.close') as HTMLButtonElement).click();
    expect(Object.keys(localStorage).some((k) => k.startsWith(DISMISSED_KEY))).toBe(true);

    client.reset();
    expect(document.getElementById(HOST_ID)).toBeNull();
    expect(Object.keys(localStorage).some((k) => k.startsWith(DISMISSED_KEY))).toBe(false);
    expect(Object.keys(sessionStorage).some((k) => k.startsWith('grovs_sb:'))).toBe(false);
    client.dispose();
  });

  it('an immediate reset from another tab clears the banner and tab-local caches', async () => {
    const transport = transportFor();
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();
    await settle();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    expect(Object.keys(sessionStorage).some((k) => k.startsWith('grovs_sb:'))).toBe(true);

    window.dispatchEvent(new StorageEvent('storage', { key: 'linksquared', oldValue: 'v1', newValue: null }));

    expect(document.getElementById(HOST_ID)).toBeNull();
    expect(Object.keys(sessionStorage).some((k) => k.startsWith('grovs_sb:'))).toBe(false);
    client.dispose();
  });

  it('a delayed reset from another tab (already reauthenticated) still clears this tab’s banner caches', async () => {
    const transport = transportFor();
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();
    await settle();
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    expect(Object.keys(sessionStorage).some((k) => k.startsWith('grovs_sb:'))).toBe(true);

    // The other tab already reset and authenticated as a new visitor by the
    // time this tab's reset event is handled.
    localStorage.setItem('linksquared', 'v2');
    window.dispatchEvent(new StorageEvent('storage', { key: 'linksquared', oldValue: 'v1', newValue: null }));

    expect(document.getElementById(HOST_ID)).toBeNull();
    expect(Object.keys(sessionStorage).some((k) => k.startsWith('grovs_sb:'))).toBe(false);
    // Delayed path: this tab's memory is cleared, but the device identifier the
    // other tab wrote is left alone.
    expect(localStorage.getItem('linksquared')).toBe('v2');
    client.dispose();
    localStorage.removeItem('linksquared');
  });

  it('a list response held across reset() is neither cached nor shown', async () => {
    const transport = new HoldingTransport();
    const held = deferred();
    transport.enqueue(auth(true));
    transport.holds.set('/smart_banners', held.promise);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();
    await settle();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(1);

    client.reset();
    held.resolve(LIST);
    await settle();
    expect(Object.keys(sessionStorage).some((k) => k.startsWith('grovs_sb:'))).toBe(false);
    expect(document.getElementById(HOST_ID)).toBeNull();
    client.dispose();
  });

  it('follows SPA navigation with autoTrackScreenViews: false', async () => {
    const transport = transportFor();
    const client = new GrovsClient(
      { apiKey: 'k', autoTrackScreenViews: false },
      { transport, autoStartEvents: true },
    );
    await client.configure();
    await settle();
    history.pushState({}, '', '/products/9');
    client.smartBanner.setLinkData({ data: { product: '9' } });
    await settle();
    const bodies = transport.requestsTo('/smart_banners/1/link').map((r) => r.body);
    expect(bodies).toContainEqual({ page_path: '/products/9', data: { product: '9' } });
    client.dispose();
  });

  it('a re-run configure() never joins the previous generation’s link request', async () => {
    const transport = transportFor();
    const held = deferred();
    transport.holds.set('/smart_banners/1/link', held.promise);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    client.smartBanner.setLinkData({ data: { product: '9' } });
    await client.configure();
    await settle();
    expect(transport.requestsTo('/smart_banners/1/link')).toHaveLength(1);

    transport.enqueue(auth(true));
    await client.configure();
    await settle();
    expect(transport.requestsTo('/smart_banners/1/link')).toHaveLength(2);
    held.resolve({ ok: true, status: 200, body: { link: 'https://go.example.com/old' } });
    client.dispose();
  });

  it('reset() drops the page’s link data', async () => {
    const transport = transportFor();
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();
    await settle();
    client.smartBanner.setLinkData({ data: { product: '9' } });
    await settle();

    const before = transport.requestsTo('/smart_banners/1/link').length;
    client.reset();
    transport.enqueue(auth(true)).enqueue(LIST);
    await client.configure();
    await settle();
    expect(transport.requestsTo('/smart_banners/1/link')).toHaveLength(before);
    client.dispose();
  });

  it('hide() survives a re-run configure() and consent on the same page', async () => {
    const transport = transportFor();
    const client = new GrovsClient({ apiKey: 'k', requireConsent: true }, { transport, autoStartEvents: false });
    await client.configure();
    client.smartBanner.hide();
    await client.grantConsent();
    await settle();
    expect(transport.requestsTo('/smart_banners')).toHaveLength(1);
    expect(document.getElementById(HOST_ID)).toBeNull();

    transport.enqueue(auth(true));
    await client.configure();
    await settle();
    expect(document.getElementById(HOST_ID)).toBeNull();
    client.dispose();
  });
});
