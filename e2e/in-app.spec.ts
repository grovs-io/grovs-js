import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * In-app messages in a real browser, against a server the test owns: a real
 * shadow root, real layout, real clicks, real focus, and the view, click and
 * dismissal arriving as events over real HTTP.
 */

type Json = Record<string, unknown>;

const BASE = (JSON.parse(readFileSync('test/in-app-shared/cases.json', 'utf8')) as { base_campaign: Json }).base_campaign;

class Backend {
  readonly events: Json[] = [];
  campaigns: Json[] = [];
  syncs = 0;
  url = '';
  private server: http.Server | null = null;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Content-Type': 'application/json',
      };
      if (req.method === 'OPTIONS') return void res.writeHead(204, headers).end();
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const path = (req.url ?? '').replace(/^\/api\/v1\/sdk/, '');
        const body = raw ? (JSON.parse(raw) as Json) : {};
        res.writeHead(200, headers).end(JSON.stringify(this.answer(path, body)));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    // Chromium keeps its connections open, and close() waits for them.
    this.server?.closeAllConnections();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private answer(path: string, body: Json): Json {
    if (path === '/authenticate') return { linksquared: 'visitor-1', sdk_attributes: { first_name: 'Ana' } };
    if (path === '/in_app/sync') {
      this.syncs += 1;
      return {
        campaigns_changed_at: 'c1',
        user_changed_at: 'u1',
        server_time: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        first_seen_at: '2026-08-01T00:00:00Z',
        global_caps: { session: 10, day: 10 },
        campaigns: this.campaigns,
      };
    }
    if (path === '/events/batch') {
      const events = (body['events'] as Json[] | undefined) ?? [];
      this.events.push(...events);
      return { accepted: events.length, rejected: 0, errors: [] };
    }
    return {};
  }

  named(name: string): Json[] {
    return this.events.filter((event) => event['event_name'] === name);
  }
}

function campaign(changes: Json): Json {
  const merge = (base: Json, over: Json): Json => {
    const out: Json = { ...base };
    for (const key of Object.keys(over)) {
      const a = base[key];
      const b = over[key];
      const objects = [a, b].every((v) => typeof v === 'object' && v !== null && !Array.isArray(v));
      out[key] = objects ? merge(a as Json, b as Json) : b;
    }
    return out;
  };
  const now = Date.now();
  return merge(merge(BASE, { schedule: { start_at: new Date(now - 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z') } }), changes);
}

interface Sdk {
  configure(config: Json): Promise<boolean>;
  track(name: string, properties?: Json): void;
  flush(): Promise<void>;
  inApp: { setCallbacks(callbacks: Json): void };
}

/** The page's view of itself; kept local so other specs keep their own typing of the SDK on window. */
type Host = { Grovs: Sdk; __clicked?: unknown[] };

async function configure(page: Page, backend: Backend): Promise<void> {
  await page.goto('/e2e/iife.html');
  await page.waitForFunction(() => typeof (window as unknown as Host).Grovs?.configure === 'function');
  const ok = await page.evaluate(
    (baseURL) => (window as unknown as Host).Grovs.configure({ apiKey: 'k', baseURL, autoTrackScreenViews: false }),
    backend.url,
  );
  expect(ok).toBe(true);
  await expect.poll(() => backend.syncs).toBeGreaterThan(0);
}

test.describe('in-app messages', () => {
  let backend: Backend;

  test.beforeEach(async () => {
    backend = new Backend();
    await backend.start();
  });

  test.afterEach(async () => {
    await backend.stop();
  });

  test('shows an interstitial for a tracked event, personalised, and reports the view', async ({ page }) => {
    backend.campaigns = [
      campaign({
        content: {
          title: 'Hi {{ user.first_name | default: "there" }}',
          message: '{{ event.product | default: "Your item" }} is waiting',
          buttons: [
            { id: 'shop', text: 'Shop now', action: { type: 'key_value', payload: { screen: 'offers' } } },
            { id: 'later', text: 'Not now', action: { type: 'close' } },
          ],
        },
      }),
    ];
    await configure(page, backend);
    await page.evaluate(() => {
      (window as unknown as Host).__clicked = [];
      (window as unknown as Host).Grovs.inApp.setCallbacks({
        onClicked: (id: string, button: string | null, payload: unknown) => (window as unknown as Host).__clicked?.push([id, button, payload]),
      });
    });

    await page.evaluate(() => (window as unknown as Host).Grovs.track('cart_viewed', { product: 'Red Shoes' }));
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Hi Ana')).toBeVisible();
    await expect(dialog.getByText('Red Shoes is waiting')).toBeVisible();

    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport && box.width <= viewport.width && box.height <= viewport.height).toBe(true);

    await dialog.getByRole('button', { name: 'Shop now' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Host).__clicked)).toEqual([['c1', 'shop', { screen: 'offers' }]]);

    await page.evaluate(() => (window as unknown as Host).Grovs.flush());
    await expect.poll(() => backend.named('in_app_viewed').length).toBe(1);
    expect(backend.named('in_app_viewed')[0]?.['properties']).toMatchObject({ campaign_id: 'c1', template: 'interstitial' });
    expect(backend.named('in_app_clicked')[0]?.['properties']).toMatchObject({ button_id: 'shop', action: 'key_value' });
  });

  test('closes on Escape and on the close button, and reports the dismissal', async ({ page }) => {
    backend.campaigns = [campaign({ caps: { session: null } })];
    await configure(page, backend);

    await page.evaluate(() => (window as unknown as Host).Grovs.track('cart_viewed'));
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.evaluate(() => (window as unknown as Host).Grovs.track('cart_viewed'));
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.evaluate(() => (window as unknown as Host).Grovs.flush());
    await expect.poll(() => backend.named('in_app_dismissed').length).toBe(2);
  });

  test('keeps keyboard focus inside a blocking message', async ({ page }) => {
    backend.campaigns = [
      campaign({ content: { buttons: [{ id: 'ok', text: 'OK', action: { type: 'close' } }] } }),
    ];
    await configure(page, backend);
    await page.evaluate(() => (window as unknown as Host).Grovs.track('cart_viewed'));
    await expect(page.getByRole('dialog')).toBeVisible();

    const inside = (): Promise<boolean> =>
      page.evaluate(() => document.activeElement?.id === 'grovs-in-app');
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      expect(await inside()).toBe(true);
    }
  });

  test('a banner leaves the page behind it usable', async ({ page }) => {
    backend.campaigns = [campaign({ template: 'footer' })];
    await configure(page, backend);
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'host-button';
      button.textContent = 'Host button';
      button.addEventListener('click', () => (button.textContent = 'Clicked'));
      document.body.prepend(button);
    });
    await page.evaluate(() => (window as unknown as Host).Grovs.track('cart_viewed'));
    await expect(page.getByText('Hello')).toBeVisible();
    await page.locator('#host-button').click();
    await expect(page.locator('#host-button')).toHaveText('Clicked');
  });

  test('a once-only message does not show again after a reload', async ({ page }) => {
    backend.campaigns = [campaign({ caps: { lifetime: 1 } })];
    await configure(page, backend);
    await page.evaluate(() => (window as unknown as Host).Grovs.track('cart_viewed'));
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    await configure(page, backend);
    await page.evaluate(() => (window as unknown as Host).Grovs.track('cart_viewed'));
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('draws every template without overflowing the window', async ({ page }) => {
    const templates = ['cover', 'interstitial', 'half_interstitial', 'header', 'footer', 'alert'];
    backend.campaigns = templates.map((template, index) =>
      campaign({ id: template, template, triggers: [{ type: 'event', name: template }], priority: 10 - index }),
    );
    await configure(page, backend);
    const viewport = page.viewportSize();
    for (const template of templates) {
      await page.evaluate((name) => (window as unknown as Host).Grovs.track(name), template);
      const card = page.locator('#grovs-in-app').locator('.card');
      await expect(card).toBeVisible();
      const box = await card.boundingBox();
      expect(box && viewport && box.x >= 0 && box.x + box.width <= viewport.width + 1, template).toBe(true);
      await card.getByRole('button', { name: 'Close' }).click();
      await expect(page.locator('#grovs-in-app')).toHaveCount(0);
    }
  });
});
