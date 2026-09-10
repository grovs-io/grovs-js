import { expect, test as base, type Page, type Route } from '@playwright/test';
import type Grovs from '../src/index';
import type { GrovsMessage } from '../src/messages/messages';
import { E2E_ORIGIN } from './test-config';

type SDKWindow = Window & {
  Grovs: typeof Grovs;
  payloads: Record<string, unknown>[];
  configuration: Promise<boolean>;
  opening: Promise<void>;
};
const API_ORIGIN = 'https://sdk.grovs.invalid';
const message = (id: number, title: string): GrovsMessage => ({
  id, title, subtitle: 'A message for this visitor', read: false,
  access_url: `${E2E_ORIGIN}/e2e/notification.html`,
});

/** Controlled HTTP responses for browser/UI races. Real socket delivery is
 * covered separately by delivery.spec.ts. No timers decide when a race lands. */
class Backend {
  calls: { path: string; body: Record<string, unknown> }[] = [];
  notifications: GrovsMessage[] = [message(1, 'Your offer')];
  automatic: GrovsMessage[] = [];
  payload: Record<string, unknown> | null = { screen: 'checkout', offer: 'WELCOME' };
  marked = new Set<number>();
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
      case '/notifications_for_device':
        answer = { notifications: body['page'] === 1 ? this.notifications.map((m) => ({ ...m, read: this.marked.has(m.id) })) : [] };
        break;
      case '/notifications_to_display_automatically': answer = { notifications: this.automatic }; break;
      case '/number_of_unread_notifications':
        answer = { number_of_unread_notifications: this.notifications.filter((m) => !this.marked.has(m.id)).length };
        break;
      case '/mark_notification_as_read': this.marked.add(Number(body['id'])); answer = {}; break;
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

test('consent → payload → message → read receipt → reset', async ({ page, backend }) => {
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
  await page.evaluate(() => (window as unknown as SDKWindow).Grovs.showMessagesList());
  await expect(page.locator('.grovs-item')).toHaveCount(1);
  await expect(page.locator('.grovs-badge')).toHaveAttribute('data-count', '1');
  await page.locator('.grovs-item').click();
  await expect(page.locator('#Grovs-page-modal-1').getByRole('dialog')).toBeVisible();
  await expect.poll(() => backend.marked.has(1)).toBe(true);
  await expect(page.locator('.grovs-badge')).toHaveAttribute('data-count', '0');
  expect(await page.evaluate(() => (window as unknown as SDKWindow).Grovs.numberOfUnreadMessages())).toBe(0);

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

test('late message results cannot populate a replacement visitor’s list', async ({ page, backend }) => {
  await page.goto('/e2e/iife.html');
  expect(await configure(page)).toBe(true);
  backend.notifications = [message(1, 'Old visitor secret')];
  const old = backend.holdNext('/notifications_for_device');
  await page.evaluate(() => {
    const w = window as unknown as SDKWindow;
    w.opening = w.Grovs.showMessagesList();
  });
  await old.arrived;
  await page.evaluate(() => (window as unknown as SDKWindow).Grovs.reset());
  backend.notifications = [message(2, 'New visitor offer')];
  expect(await configure(page)).toBe(true);
  await page.evaluate(() => (window as unknown as SDKWindow).Grovs.showMessagesList());
  old.release();
  await page.evaluate(() => (window as unknown as SDKWindow).opening);
  await expect(page.locator('.grovs-item')).toHaveCount(1);
  await expect(page.locator('.grovs-item')).toContainText('New visitor offer');
  await expect(page.getByText('Old visitor secret', { exact: true })).toHaveCount(0);
});

test('automatic messages wait for consent, render, and disappear on reset', async ({ page, backend }) => {
  backend.automatic = [message(7, 'Automatic offer')];
  await page.goto('/e2e/iife.html');
  expect(await configure(page, true)).toBe(false);
  expect(backend.calls).toEqual([]);
  await expect(page.locator('.grovs-page-modal')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as SDKWindow).Grovs.grantConsent())).toBe(true);
  await expect(page.locator('#Grovs-page-modal-7').getByRole('dialog')).toBeVisible();
  await expect.poll(() => backend.marked.has(7)).toBe(true);
  await page.evaluate(() => (window as unknown as SDKWindow).Grovs.reset());
  await expect(page.locator('.grovs-page-modal')).toHaveCount(0);
});

test('message HTML is isolated, while its checkout popup can use storage', async ({ page, context, backend }) => {
  const title = '<img src=x onerror="window.messageInjection=true">';
  backend.notifications = [message(1, title)];
  await context.route('**/e2e/notification.html', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><a href="/e2e/checkout.html" target="_blank">Checkout</a>',
  }));
  await context.route('**/e2e/checkout.html', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Checkout</title><h1>Checkout</h1>',
  }));
  await page.goto('/e2e/iife.html');
  expect(await configure(page)).toBe(true);
  await page.evaluate(() => (window as unknown as SDKWindow).Grovs.showMessagesList());
  await expect(page.locator('.grovs-item')).toContainText(title);
  expect(await page.evaluate(() => 'messageInjection' in window)).toBe(false);
  await page.locator('.grovs-item').click();
  const frame = page.frameLocator('#Grovs-page-modal-1 iframe');
  await expect(frame.getByRole('link', { name: 'Checkout' })).toBeVisible();
  const element = await page.locator('#Grovs-page-modal-1 iframe').elementHandle();
  const content = await element!.contentFrame();
  expect(await content!.evaluate(() => {
    try { parent.document.body.dataset['escaped'] = 'yes'; return true; } catch { return false; }
  })).toBe(false);
  const popupPromise = page.waitForEvent('popup');
  await frame.getByRole('link', { name: 'Checkout' }).click();
  const popup = await popupPromise;
  await popup.waitForURL('**/e2e/checkout.html');
  await popup.waitForLoadState('domcontentloaded');
  expect(await popup.evaluate(() => {
    sessionStorage.setItem('checkout-test', 'works');
    return sessionStorage.getItem('checkout-test');
  })).toBe('works');
  await popup.close();
});
