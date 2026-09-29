import { expect, test as base, type Page, type Route } from '@playwright/test';
import type Grovs from '../src/index';

type SDKWindow = Window & {
  Grovs: typeof Grovs;
  payloads: Record<string, unknown>[];
  configuration: Promise<boolean>;
  opening: Promise<void>;
};
const API_ORIGIN = 'https://sdk.grovs.invalid';

/** Controlled HTTP responses for browser/UI races. Real socket delivery is
 * covered separately by delivery.spec.ts. No timers decide when a race lands. */
class Backend {
  calls: { path: string; body: Record<string, unknown> }[] = [];
  payload: Record<string, unknown> | null = { screen: 'checkout', offer: 'WELCOME' };
  private holds = new Map<string, { arrived: () => void; wait: Promise<void> }>();
  private releases: (() => void)[] = [];

  holdNext(path: string): { arrived: Promise<void>; release: () => void } {
    let arrived!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { arrived = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.holds.set(path, { arrived, wait });
    this.releases.push(release);
    return { arrived: started, release };
  }

  releaseAll(): void { this.releases.forEach((release) => release()); }

  async handle(route: Route): Promise<void> {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/sdk', '');
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    this.calls.push({ path, body });
    let answer: unknown;
    switch (path) {
      case '/authenticate': answer = { linksquared: 'flow-visitor' }; break;
      case '/data_for_device_and_path': answer = { data: this.payload }; break;
      case '/data_for_device': answer = { data: null }; break;
      case '/events/batch': answer = { accepted: (body['events'] as unknown[]).length, rejected: 0, errors: [] }; break;
      // These flows are about links; no in-app campaign takes part.
      case '/in_app/sync':
        answer = { campaigns_changed_at: 'c', user_changed_at: 'u', server_time: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          store_url: null, first_seen_at: null, global_caps: { session: 10, day: 10 }, campaigns: [], test_messages: [] };
        break;
      default: throw new Error(`Unexpected SDK endpoint: ${path}`);
    }
    // Capture the old response before waiting: replacing fixture data must
    // not turn a delayed visitor-A response into a visitor-B response.
    const json = JSON.stringify(answer);
    const hold = this.holds.get(path);
    if (hold) {
      this.holds.delete(path);
      hold.arrived();
      await hold.wait;
    }
    await route.fulfill({ contentType: 'application/json', body: json, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}

const test = base.extend<{ backend: Backend }>({
  backend: async ({ context, page }, use, testInfo) => {
    const backend = new Backend();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await context.route(`${API_ORIGIN}/**`, (route) => backend.handle(route));
    await context.route('**/e2e/notification.html', (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><h1>Your message</h1>',
    }));
    try { await use(backend); } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        const modals = await page.evaluate(() => Array.from(document.querySelectorAll('div'))
          .filter((node) => node.shadowRoot)
          .map((node) => ({ id: node.id, shadow: node.shadowRoot?.innerHTML }))).catch(() => []);
        await testInfo.attach('sdk-flow-state', {
          body: Buffer.from(JSON.stringify({ calls: backend.calls, errors, modals }, null, 2)),
          contentType: 'application/json',
        });
      }
      backend.releaseAll();
      await context.unrouteAll({ behavior: 'wait' });
    }
  },
});

async function configure(page: Page, requireConsent = false, wait = true): Promise<boolean | null> {
  return page.evaluate(async ({ baseURL, requireConsent, wait }) => {
    const w = window as unknown as SDKWindow;
    w.payloads ??= [];
    w.configuration = w.Grovs.configure({
      apiKey: 'flow-key', baseURL, requireConsent, autoTrackScreenViews: false,
      onDeeplink: (payload) => w.payloads.push(payload),
    });
    return wait ? await w.configuration : null;
  }, { baseURL: API_ORIGIN, requireConsent, wait });
}

test('consent → payload → reset', async ({ page, backend }) => {
  await page.goto('/e2e/iife.html?Grovs=welcome');
  expect(await configure(page, true)).toBe(false);
  await page.evaluate(async () => {
    const sdk = (window as unknown as SDKWindow).Grovs;
    sdk.track('before_consent');
    await sdk.getMessages(1);
    await sdk.numberOfUnreadMessages();
    await sdk.displayAutomaticMessages();
    await sdk.flush();
  });
  expect(backend.calls).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as SDKWindow).payloads)).toEqual([]);
  expect(await page.evaluate(() => ({ cookie: document.cookie, keys: Object.keys(localStorage) }))).toEqual({ cookie: '', keys: [] });

  expect(await page.evaluate(() => (window as unknown as SDKWindow).Grovs.grantConsent())).toBe(true);
  expect(await page.evaluate(() => (window as unknown as SDKWindow).payloads)).toEqual([backend.payload]);
  // The removed inbox: the methods answer empty and open nothing.
  await page.evaluate(() => (window as unknown as SDKWindow).Grovs.showMessagesList());
  expect(await page.evaluate(async () => {
    const sdk = (window as unknown as SDKWindow).Grovs;
    return [await sdk.getMessages(1), await sdk.numberOfUnreadMessages(), await sdk.markMessageAsRead(1)];
  })).toEqual([[], 0, true]);
  await expect(page.locator('#Grovs-modal, .grovs-page-modal')).toHaveCount(0);
  expect(backend.calls.filter((c) => c.path.includes('notification'))).toEqual([]);

  await page.evaluate(() => (window as unknown as SDKWindow).Grovs.reset());
  await expect(page.locator('#Grovs-modal, .grovs-page-modal')).toHaveCount(0);
  const count = backend.calls.length;
  await page.evaluate(async () => {
    const sdk = (window as unknown as SDKWindow).Grovs;
    await sdk.getMessages(1);
    await sdk.displayAutomaticMessages();
    await sdk.flush();
  });
  expect(backend.calls).toHaveLength(count);
});

test('refresh with the link token delivers a callback on each page', async ({ page, backend }) => {
  await page.goto('/e2e/iife.html?Grovs=welcome');
  expect(await configure(page)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as SDKWindow).payloads)).toEqual([backend.payload]);
  await page.reload();
  expect(await configure(page)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as SDKWindow).payloads)).toEqual([backend.payload]);
  expect(backend.calls.filter((c) => c.path === '/data_for_device_and_path')).toHaveLength(2);
});

test('a payload arriving after reset cannot reach the replacement visitor', async ({ page, backend }) => {
  const old = backend.holdNext('/data_for_device_and_path');
  backend.payload = { visitor: 'old' };
  await page.goto('/e2e/iife.html?Grovs=welcome');
  await configure(page, false, false);
  await old.arrived;
  await page.evaluate(() => {
    const w = window as unknown as SDKWindow;
    w.Grovs.reset();
    w.opening = w.configuration.then(() => {});
  });
  backend.payload = { visitor: 'new' };
  expect(await configure(page)).toBe(true);
  old.release();
  await page.evaluate(() => (window as unknown as SDKWindow).opening);
  expect(await page.evaluate(() => (window as unknown as SDKWindow).payloads)).toEqual([{ visitor: 'new' }]);
  expect(await page.evaluate(() => (window as unknown as SDKWindow).Grovs.lastReceivedPayload())).toEqual({ visitor: 'new' });
});
