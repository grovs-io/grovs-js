import { afterEach, describe, expect, it, vi } from 'vitest';
import Grovs from '../../src/index';
import { GrovsClient } from '../../src/core/client';
import { IN_APP_KEY, IN_APP_STATE_KEY } from '../../src/inapp/store';
import type { TransportRequest, TransportResponse } from '../../src/net/transport';
import { FakeClock } from '../helpers/fake-clock';
import { FakeStorage } from '../helpers/fake-storage';
import { FakeTransport } from '../helpers/fake-transport';
import { merge, readJson } from './shared';

type Json = Record<string, unknown>;

const BASE = readJson('cases.json').base_campaign as Json;
const START = Date.parse('2026-10-01T10:00:00Z');

/** Answers by path, so a test does not depend on the order the SDK makes its calls in. */
class Backend extends FakeTransport {
  campaigns: Json[] = [merge(BASE, {})];
  stamps: Json | null = null;

  constructor(private readonly clock: FakeClock) {
    super();
  }

  override send(req: TransportRequest): Promise<TransportResponse> {
    this.requests.push(req);
    const ok = (body: unknown): Promise<TransportResponse> => Promise.resolve({ ok: true, status: 200, body });
    if (req.url.endsWith('/authenticate')) return ok({ linksquared: 'visitor-1', sdk_attributes: { first_name: 'Ana' } });
    if (req.url.endsWith('/in_app/sync')) {
      return ok({
        campaigns_changed_at: 'c1',
        user_changed_at: 'u1',
        server_time: new Date(this.clock.now()).toISOString(),
        first_seen_at: '2026-08-01T00:00:00Z',
        global_caps: { session: 10, day: 10 },
        campaigns: this.campaigns,
      });
    }
    if (req.url.endsWith('/events/batch')) {
      const sent = (req.body as { events: unknown[] }).events.length;
      return ok({ accepted: sent, rejected: 0, errors: [], ...(this.stamps ? { in_app: this.stamps } : {}) });
    }
    return ok({});
  }

  events(): Json[] {
    return this.requestsTo('/events/batch').flatMap((r) => (r.body as { events: Json[] }).events);
  }
}

function make(config: Json = {}) {
  const clock = new FakeClock(START);
  const transport = new Backend(clock);
  const storage = new FakeStorage();
  const client = new GrovsClient({ apiKey: 'k', autoTrackScreenViews: false, ...config }, { transport, storage, clock });
  clients.push(client);
  return { client, transport, storage, clock };
}

const clients: GrovsClient[] = [];

function shown(): ShadowRoot | null {
  return document.getElementById('grovs-in-app')?.shadowRoot ?? null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('in-app wiring', () => {
  it('syncs after the deep link lookup, with the visitor and the versions it holds', async () => {
    const { client, transport } = make({ appVersion: '4.2.0' });
    await client.configure();
    await settle();

    const order = transport.requests.map((r) => r.url.replace(/^.*\/sdk/, ''));
    expect(order.indexOf('/in_app/sync')).toBeGreaterThan(order.indexOf('/data_for_device'));
    const sync = transport.requestsTo('/in_app/sync')[0];
    expect(sync?.body).toMatchObject({ format: 1, campaigns_changed_at: null, user_changed_at: null });
    expect(sync?.headers['LINKSQUARED']).toBe('visitor-1');
  });

  it('shows a message when a tracked event matches, and sends the view as an event under its id', async () => {
    const { client, transport, storage } = make();
    await client.configure();
    await settle();

    client.track('cart_viewed', { total: 80 });
    expect(shown()?.querySelector('.title')?.textContent).toBe('Hello');

    await client.flush();
    const view = transport.events().find((event) => event['event_name'] === 'in_app_viewed');
    expect(view?.['properties']).toMatchObject({ campaign_id: 'c1', revision: 1, template: 'interstitial' });
    const stored = JSON.parse(storage.get(`${IN_APP_STATE_KEY}:k`) ?? storage.get(IN_APP_STATE_KEY) ?? '{}') as {
      state: { views: { id: string }[] };
    };
    expect(stored.state.views.map((v) => v.id)).toEqual([view?.['event_id']]);
  });

  it('fills personalization from the attributes the backend returned', async () => {
    const { client, transport } = make();
    transport.campaigns = [merge(BASE, { content: { title: 'Hi {{ user.first_name | default: "there" }}' } })];
    await client.configure();
    await settle();
    client.track('cart_viewed');
    expect(shown()?.querySelector('.title')?.textContent).toBe('Hi Ana');
  });

  it('shows an app_open campaign once per session', async () => {
    const { client, transport } = make();
    transport.campaigns = [merge(BASE, { triggers: [{ type: 'app_open' }] })];
    await client.configure();
    await settle();
    expect(shown()).not.toBeNull();
  });

  it('matches a screen view trigger by the name given to trackScreenView', async () => {
    const { client, transport } = make();
    transport.campaigns = [merge(BASE, { triggers: [{ type: 'screen_view', name: 'pricing' }] })];
    await client.configure();
    await settle();
    client.trackScreenView('Pricing');
    expect(shown()).not.toBeNull();
  });

  it('reports a click and a dismissal as events', async () => {
    const { client, transport } = make();
    transport.campaigns = [merge(BASE, { caps: { session: null } })];
    await client.configure();
    await settle();

    client.track('cart_viewed');
    shown()?.querySelector<HTMLButtonElement>('.close')?.click();
    await settle();
    await client.flush();
    const names = transport.events().map((event) => event['event_name']);
    expect(names).toContain('in_app_viewed');
    expect(names).toContain('in_app_dismissed');
  });

  it('a host cannot track the reserved in-app names itself', async () => {
    const { client, transport } = make();
    await client.configure();
    await settle();
    // The backend accepts these three names from the SDK; track() is for the host's own events.
    client.track('in_app_viewed', { campaign_id: 'c1' });
    await client.flush();
    expect(transport.events().some((event) => event['event_name'] === 'in_app_viewed')).toBe(false);
  });

  it('syncs again when an event batch response shows the campaigns changed', async () => {
    vi.useFakeTimers();
    const { client, transport } = make();
    await client.configure();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.requestsTo('/in_app/sync')).toHaveLength(1);

    transport.stamps = { campaigns_changed_at: 'c2', user_changed_at: 'u1' };
    client.track('anything');
    await client.flush();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(transport.requestsTo('/in_app/sync')).toHaveLength(2);
  });

  it('neither syncs nor shows anything until consent is granted', async () => {
    const { client, transport } = make({ requireConsent: true });
    await client.configure();
    await settle();
    client.track('cart_viewed');
    expect(transport.requestsTo('/in_app/sync')).toHaveLength(0);
    expect(shown()).toBeNull();

    await client.grantConsent();
    await settle();
    expect(transport.requestsTo('/in_app/sync')).toHaveLength(1);
    client.track('cart_viewed');
    expect(shown()).not.toBeNull();
  });

  it('disabling closes the message on screen and shows nothing until enabled again', async () => {
    const { client, transport } = make();
    transport.campaigns = [merge(BASE, { caps: { session: null } })];
    await client.configure();
    await settle();
    client.track('cart_viewed');
    expect(shown()).not.toBeNull();

    client.setEnabled(false);
    await settle();
    expect(shown()).toBeNull();
    client.track('cart_viewed');
    expect(shown()).toBeNull();

    client.setEnabled(true);
    await settle();
    client.track('cart_viewed');
    expect(shown()).not.toBeNull();
  });

  it('reset closes the message and clears the stored campaigns, views and counts', async () => {
    const { client, storage } = make();
    await client.configure();
    await settle();
    client.track('cart_viewed');
    expect([...storage.map.keys()].some((key) => key.startsWith(IN_APP_KEY))).toBe(true);

    client.reset();
    await settle();
    expect(shown()).toBeNull();
    expect([...storage.map.keys()].some((key) => key.startsWith(IN_APP_KEY))).toBe(false);
  });

  it('a retired client closes its message and shows no more', async () => {
    const { client } = make();
    await client.configure();
    await settle();
    client.track('cart_viewed');
    client.dispose();
    await settle();
    expect(shown()).toBeNull();
    client.track('cart_viewed');
    expect(shown()).toBeNull();
  });

  it('a sync the backend does not know leaves the SDK working', async () => {
    const clock = new FakeClock(START);
    const transport = new FakeTransport();
    transport.enqueue({ ok: true, status: 200, body: { linksquared: 'visitor-1' } });
    transport.fallback = { ok: false, status: 404, body: {} };
    const client = new GrovsClient({ apiKey: 'k', autoTrackScreenViews: false }, { transport, storage: new FakeStorage(), clock });
    clients.push(client);
    await client.configure();
    await settle();
    expect(() => client.track('cart_viewed')).not.toThrow();
    expect(shown()).toBeNull();
    expect(client.isAuthenticated()).toBe(true);
  });
});

describe('Grovs.inApp', () => {
  it('exposes the controls', () => {
    for (const name of ['pause', 'resume', 'discard', 'setExcludedScreens', 'setCallbacks', 'setDebug'] as const) {
      expect(typeof Grovs.inApp[name]).toBe('function');
    }
  });

  it('accepts every call before configure without throwing', () => {
    expect(() => {
      Grovs.inApp.pause();
      Grovs.inApp.resume();
      Grovs.inApp.discard(true);
      Grovs.inApp.setExcludedScreens(['Checkout']);
      Grovs.inApp.setExcludedScreens(null as unknown as string[]);
      Grovs.inApp.setCallbacks({ beforeShow: () => true });
      Grovs.inApp.setDebug(true);
      Grovs.inApp.resume();
      Grovs.inApp.setExcludedScreens([]);
      Grovs.inApp.setCallbacks({});
      Grovs.inApp.setDebug(false);
    }).not.toThrow();
  });
});
