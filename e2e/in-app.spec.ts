import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { expect, test, type Frame, type Page } from '@playwright/test';

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
  userAttributes: Json | null;
  inApp: { setCallbacks(callbacks: Json): void; pause(): void };
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

  test('a stars question in a banner is answered with one click, commented on and thanked for', async ({ page }) => {
    const question = {
      id: 'q1',
      type: 'stars',
      options: [],
      comment: { split: 3, low: 'What went wrong?', high: 'What did you like?' },
      thanks: 'Thank you',
      review_from: null,
    };
    backend.campaigns = [campaign({ template: 'footer', content: { title: 'How was it?', message: null, question } })];
    await configure(page, backend);
    await page.evaluate(() => (window as unknown as Host).Grovs.track('cart_viewed'));

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('How was it?')).toBeVisible();
    await dialog.getByRole('button', { name: '4 of 5' }).click();
    await page.evaluate(() => (window as unknown as Host).Grovs.flush());
    await expect.poll(() => backend.named('in_app_answered').length).toBe(1);

    await expect(dialog.getByText('What did you like?')).toBeVisible();
    await dialog.getByRole('textbox').fill('  Fast delivery ');
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(dialog.getByText('Thank you')).toBeVisible();
    await expect(dialog).toHaveCount(0, { timeout: 4000 });

    await page.evaluate(() => (window as unknown as Host).Grovs.flush());
    await expect.poll(() => backend.named('in_app_commented').length).toBe(1);
    const answer = { campaign_id: 'c1', revision: 1, question_id: 'q1', type: 'stars', value: 4 };
    expect(backend.named('in_app_answered')[0]?.['properties']).toMatchObject(answer);
    expect(backend.named('in_app_commented')[0]?.['properties']).toMatchObject({ ...answer, comment: 'Fast delivery' });
    expect(backend.named('in_app_dismissed')).toHaveLength(0);
    expect(backend.named('in_app_clicked')).toHaveLength(0);
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

test.describe('html messages', () => {
  let backend: Backend;
  const host = (page: Page) => page.locator('#grovs-in-app');
  const shown = (page: Page) => host(page).locator('.layer.html:not(.pending)');
  const frameBox = (page: Page) => host(page).locator('iframe').boundingBox();
  const track = (page: Page, name = 'cart_viewed') => page.evaluate((n) => (window as unknown as Host).Grovs.track(n), name);
  const flush = (page: Page) => page.evaluate(() => (window as unknown as Host).Grovs.flush());

  function html(body: string, layout = 'modal', changes: Json = {}): Json {
    const content = { html: body, layout, ...(changes['content'] as Json | undefined) };
    return campaign({ template: 'html', caps: { session: null }, ...changes, content });
  }

  /** The campaigns are stored once the sync's answer is applied. */
  async function ready(page: Page): Promise<void> {
    await configure(page, backend);
    await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.startsWith('grovs_in_app:')));
  }

  function messageFrame(page: Page): Frame {
    const frame = page.frames().find((each) => each !== page.mainFrame());
    if (!frame) throw new Error('no message frame');
    return frame;
  }

  test.beforeEach(async () => {
    backend = new Backend();
    await backend.start();
  });

  test.afterEach(async () => {
    await backend.stop();
  });

  test('shows in each layout, sized by its content, always with a close control that works', async ({ page }) => {
    const body = '<!doctype html><body style="margin:0"><p style="margin:0;height:120px">Hello</p></body>';
    const layouts = ['modal', 'banner_top', 'banner_bottom', 'full'];
    backend.campaigns = layouts.map((layout) =>
      html(body, layout, { id: layout, triggers: [{ type: 'event', name: layout }], content: { close_button: false } }),
    );
    await ready(page);
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    for (const layout of layouts) {
      await track(page, layout);
      await expect(shown(page)).toBeVisible();
      // Polled: the card slides in over 160 ms.
      const placed = async (): Promise<unknown> => {
        const box = await frameBox(page);
        if (!box) return null;
        if (layout === 'modal') return [box.width <= 420, Math.round(box.height)];
        if (layout === 'banner_top') return [Math.round(box.y), box.width, Math.round(box.height)];
        if (layout === 'banner_bottom') return [Math.round(box.y + box.height), box.width, Math.round(box.height)];
        return [box.width, box.height];
      };
      const expected = {
        modal: [true, 120],
        banner_top: [0, viewport.width, 120],
        banner_bottom: [viewport.height, viewport.width, 120],
        full: [viewport.width, viewport.height],
      }[layout];
      await expect.poll(placed).toEqual(expected);
      await host(page).getByRole('button', { name: 'Close' }).click();
      await expect(host(page)).toHaveCount(0);
    }
    await flush(page);
    await expect.poll(() => backend.named('in_app_viewed').length).toBe(4);
    await expect.poll(() => backend.named('in_app_dismissed').length).toBe(4);
  });

  test('runs in standards mode with autoplay allowed, and leaves no __grovs behind', async ({ page }) => {
    backend.campaigns = [html('<!-- promo --><!doctype html><p>Hi</p>')];
    await ready(page);
    await track(page);
    await expect(shown(page)).toBeVisible();
    expect(await host(page).locator('iframe').getAttribute('allow')).toContain('autoplay');
    expect(await host(page).locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
    const inside = await messageFrame(page).evaluate(() => [document.compatMode, '__grovs' in window, typeof (window as unknown as { grovs: unknown }).grovs]);
    expect(inside).toEqual(['CSS1Compat', false, 'object']);
  });

  test('a page script cannot read the token, and a forged open is ignored', async ({ page }) => {
    await page.route('https://acme.example/**', (route) => route.fulfill({ contentType: 'text/html', body: 'landed' }));
    backend.campaigns = [
      html(
        '<!doctype html><p>Hi</p><script>' +
          'var text = [].map.call(document.scripts, function (s) { return s.textContent; }).join("") + document.documentElement.outerHTML;' +
          'window.leaked = { boot: text.indexOf("__gro" + "vs") >= 0, token: (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text) || [""])[0] };' +
          'setTimeout(function () { parent.postMessage({ v: 1, token: window.leaked.token, id: "f", type: "open", args: { url: "https://acme.example/forged", active: true } }, "*"); }, 1000);' +
          '</script>',
      ),
    ];
    await ready(page);
    await track(page);
    await expect(shown(page)).toBeVisible();
    expect(await messageFrame(page).evaluate(() => (window as unknown as { leaked: unknown }).leaked)).toEqual({ boot: false, token: '' });
    await page.waitForTimeout(1500);
    expect(page.url()).toContain('/e2e/iife.html');
    await expect(shown(page)).toBeVisible();
  });

  const envelopes = (token: string): Json[] => [
    { v: 1, token, id: 'f1', type: 'track', args: { name: 'forged', properties: {} } },
    { v: 1, token, id: 'f2', type: 'open', args: { url: 'https://acme.example/forged', active: true } },
    { v: 1, token, id: 'f3', type: 'close', args: {} },
  ];
  const readToken = (page: Page): Promise<string> =>
    host(page).locator('iframe').evaluate((frame) => /token:"([^"]+)"/.exec((frame as HTMLIFrameElement).srcdoc)?.[1] ?? '');

  /** Forgeries must change nothing, while the real bridge still gets through afterwards. */
  async function expectIgnored(page: Page, opened: string[]): Promise<void> {
    await page.waitForTimeout(500);
    expect(page.url()).toContain('/e2e/iife.html');
    expect(opened).toEqual([]);
    await expect(shown(page)).toBeVisible();
    await messageFrame(page).evaluate(() => (window as unknown as { grovs: Sdk }).grovs.track('real'));
    await flush(page);
    await expect.poll(() => backend.named('real').length).toBe(1);
    expect(backend.named('forged')).toHaveLength(0);
    expect(backend.named('in_app_dismissed')).toHaveLength(0);
  }

  test('a nested frame posting a valid envelope to the host or to the message is ignored', async ({ page }) => {
    const opened: string[] = [];
    await page.route('https://acme.example/**', (route) => (opened.push(route.request().url()), route.fulfill({ body: 'landed' })));
    backend.campaigns = [html('<!doctype html><p>Hi</p>')];
    await ready(page);
    await track(page);
    await expect(shown(page)).toBeVisible();
    const token = await readToken(page);
    expect(token).not.toBe('');
    const script =
      `<script>var all = ${JSON.stringify(envelopes(token))};` +
      'all.forEach(function (m) { parent.parent.postMessage(m, "*"); parent.postMessage(m, "*"); }); window.sent = all.length;</script>';
    await messageFrame(page).evaluate((srcdoc) => {
      const nested = document.createElement('iframe');
      nested.srcdoc = srcdoc;
      document.body.append(nested);
    }, script);
    await expect.poll(async () => {
      const nested = page.frames().find((each) => each.parentFrame() === messageFrame(page));
      return nested?.evaluate(() => (window as unknown as { sent?: number }).sent);
    }).toBe(3);
    await expectIgnored(page, opened);
  });

  test('a message script posting envelopes with a made-up token is ignored', async ({ page }) => {
    const opened: string[] = [];
    await page.route('https://acme.example/**', (route) => (opened.push(route.request().url()), route.fulfill({ body: 'landed' })));
    backend.campaigns = [html('<!doctype html><p>Hi</p>')];
    await ready(page);
    await track(page);
    await expect(shown(page)).toBeVisible();
    await messageFrame(page).evaluate((all) => all.forEach((m) => parent.postMessage(m, '*')), envelopes('00000000-0000-4000-8000-000000000000'));
    await expectIgnored(page, opened);
  });

  test('fills placeholders before it is shown, and skips a page with a missing field uncounted', async ({ page }) => {
    backend.campaigns = [
      html('<!doctype html><p id="t">Hi {{ user.first_name }}</p>'),
      html('<!doctype html><p>Hi {{ user.missing }}</p>', 'modal', { id: 'missing', priority: 9, triggers: [{ type: 'event', name: 'other' }] }),
    ];
    await ready(page);
    await track(page, 'other');
    await expect(host(page)).toHaveCount(0);
    await track(page);
    await expect(shown(page)).toBeVisible();
    expect(await messageFrame(page).locator('#t').textContent()).toBe('Hi Ana');
    await flush(page);
    await expect.poll(() => backend.named('in_app_viewed').length).toBe(1);
    expect(backend.named('in_app_viewed')[0]?.['properties']).toMatchObject({ campaign_id: 'c1', template: 'html' });
  });

  test('declarative track counts one click with the event, and close dismisses', async ({ page }) => {
    backend.campaigns = [
      html(
        '<!doctype html><button id="like" data-grovs-action="track" data-grovs-event="liked">Like</button>' +
          '<button id="no" data-grovs-action="close">No thanks</button>',
      ),
    ];
    await ready(page);
    await track(page);
    await expect(shown(page)).toBeVisible();
    const frame = messageFrame(page);
    await frame.click('#like');
    await frame.click('#like');
    await frame.click('#no');
    await expect(host(page)).toHaveCount(0);
    await flush(page);
    await expect.poll(() => backend.named('liked').length).toBe(2);
    expect(backend.named('liked')[0]?.['properties']).toMatchObject({ campaign_id: 'c1' });
    expect(backend.named('in_app_clicked')).toHaveLength(1);
    expect(backend.named('in_app_clicked')[0]?.['properties']).toEqual({ campaign_id: 'c1', revision: 1, action: 'track' });
    await expect.poll(() => backend.named('in_app_dismissed').length).toBe(1);
  });

  for (const [name, body] of [
    ['a declarative open', '<button id="go" data-grovs-action="open" data-grovs-url="https://acme.example/landing">Go</button>'],
    ['a plain link', '<a id="go" href="https://acme.example/landing">Go</a>'],
  ] as const) {
    test(`${name} navigates the current tab`, async ({ page }) => {
      await page.route('https://acme.example/**', (route) => route.fulfill({ contentType: 'text/html', body: 'landed' }));
      backend.campaigns = [html(`<!doctype html>${body}`)];
      await ready(page);
      await track(page);
      await expect(shown(page)).toBeVisible();
      await messageFrame(page).click('#go');
      await page.waitForURL('https://acme.example/landing');
      expect(page.context().pages()).toHaveLength(1);
    });
  }

  test('a page that opens a link by itself does not navigate; a click does', async ({ page, browserName }) => {
    test.skip(!(await page.evaluate(() => 'userActivation' in navigator)), 'no navigator.userActivation');
    // Firefox lends the host page's activation (Playwright's evaluate) to frames for ~5 s; Chromium and WebKit do not.
    const delay = browserName === 'firefox' ? 6000 : 1000;
    await page.route('https://acme.example/**', (route) => route.fulfill({ contentType: 'text/html', body: 'landed' }));
    backend.campaigns = [
      html(
        '<!doctype html><script>grovs.open("https://acme.example/load");' +
          `setTimeout(function () { grovs.open("https://acme.example/auto"); }, ${delay})</script>` +
          '<button id="go" onclick="grovs.open(\'https://acme.example/landing\')">Go</button>',
      ),
    ];
    await ready(page);
    await track(page);
    await expect(shown(page)).toBeVisible();
    await page.waitForTimeout(delay + 500);
    expect(page.url()).toContain('/e2e/iife.html');
    await expect(shown(page)).toBeVisible();
    await messageFrame(page).click('#go');
    await page.waitForURL('https://acme.example/landing');
  });

  test('a page forging activation through call, apply or isActive does not navigate; a click does', async ({ page, browserName }) => {
    test.skip(!(await page.evaluate(() => 'userActivation' in navigator)), 'no navigator.userActivation');
    // Firefox lends the host page's activation (Playwright's evaluate) to frames for ~5 s; Chromium and WebKit do not.
    const delay = browserName === 'firefox' ? 6000 : 1000;
    await page.route('https://acme.example/**', (route) => route.fulfill({ contentType: 'text/html', body: 'landed' }));
    backend.campaigns = [
      html(
        '<!doctype html><script>Function.prototype.call = function () { return true; };' +
          'Function.prototype.apply = function () { return true; };' +
          'Object.defineProperty(UserActivation.prototype, "isActive", { get: function () { return true; } });' +
          `setTimeout(function () { grovs.open("https://acme.example/forged"); }, ${delay})</script>` +
          '<button id="go" onclick="grovs.open(\'https://acme.example/landing\')">Go</button>',
      ),
    ];
    await ready(page);
    await track(page);
    await expect(shown(page)).toBeVisible();
    await page.waitForTimeout(delay + 500);
    expect(page.url()).toContain('/e2e/iife.html');
    await expect(shown(page)).toBeVisible();
    await messageFrame(page).click('#go');
    await page.waitForURL('https://acme.example/landing');
  });

  test('a page reporting a tiny height keeps its close button whole and clickable', async ({ page }) => {
    backend.campaigns = [
      html('<!doctype html><body style="margin:0"><div style="height:1px"></div></body>', 'modal', { content: { dismissible: false } }),
    ];
    await ready(page);
    await track(page);
    await expect(shown(page)).toBeVisible();
    await expect.poll(async () => Math.round((await frameBox(page))?.height ?? 0)).toBe(44);
    await host(page).getByRole('button', { name: 'Close' }).click();
    await expect(host(page)).toHaveCount(0);
  });

  test('a page that navigates itself is torn down, and what it posts afterwards is ignored', async ({ page }) => {
    let token = '';
    await page.route('https://acme.example/away', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body:
          '<script>setTimeout(function () { parent.postMessage(' +
          `{ v: 1, token: ${JSON.stringify(token)}, id: "x", type: "setAttribute", args: { key: "hijack", value: "1" } }` +
          ', "*"); }, 200);</script>',
      }),
    );
    backend.campaigns = [html('<!doctype html><p>Hi</p>')];
    await ready(page);
    await track(page);
    await expect(shown(page)).toBeVisible();
    token = await host(page).locator('iframe').evaluate((frame) => /token:"([^"]+)"/.exec((frame as HTMLIFrameElement).srcdoc)?.[1] ?? '');
    await messageFrame(page).evaluate(() => (location.href = 'https://acme.example/away'));
    await expect(host(page)).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as Host).Grovs.userAttributes?.['hijack'])).toBeUndefined();
  });

  test('a slow page is not revealed once the host has paused messages, and counts no view', async ({ page }) => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('https://acme.example/slow.js', async (route) => {
      await held;
      await route.fulfill({ contentType: 'text/javascript', body: '' });
    });
    backend.campaigns = [html('<!doctype html><script src="https://acme.example/slow.js"></script><p>Hi</p>')];
    await ready(page);
    await track(page);
    await expect(host(page)).toHaveCount(1);
    await page.evaluate(() => (window as unknown as Host).Grovs.inApp.pause());
    release();
    await expect(host(page)).toHaveCount(0);
    await flush(page);
    expect(backend.named('in_app_viewed')).toHaveLength(0);
  });

  test('a page that never loads is torn down at the 5 s deadline without a view', async ({ page }) => {
    await page.route('https://acme.example/never.js', () => undefined);
    backend.campaigns = [html('<!doctype html><script src="https://acme.example/never.js"></script><p>Hi</p>')];
    await ready(page);
    await track(page);
    await expect(host(page)).toHaveCount(1);
    await page.waitForTimeout(1000);
    await expect(shown(page)).toHaveCount(0);
    await expect(host(page)).toHaveCount(0, { timeout: 6000 });
    await flush(page);
    expect(backend.named('in_app_viewed')).toHaveLength(0);
  });

  test('a tall page is clamped to its layout, and a 100%-high page holds the largest card', async ({ page }) => {
    const tall = '<!doctype html><body style="margin:0"><div style="height:3000px">Tall</div></body>';
    backend.campaigns = [
      html(tall, 'modal', { id: 'modal', triggers: [{ type: 'event', name: 'modal' }] }),
      html(tall, 'banner_bottom', { id: 'banner', triggers: [{ type: 'event', name: 'banner' }] }),
      html('<!doctype html><style>html,body{height:100%;margin:0}</style><p>Full height</p>', 'modal', {
        id: 'relative',
        triggers: [{ type: 'event', name: 'relative' }],
      }),
    ];
    await ready(page);
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    for (const [name, share] of [['modal', 0.9], ['banner', 0.3]] as const) {
      await track(page, name);
      await expect(shown(page)).toBeVisible();
      const box = await frameBox(page);
      expect(Math.abs((box?.height ?? 0) - viewport.height * share)).toBeLessThanOrEqual(1);
      await host(page).getByRole('button', { name: 'Close' }).click();
      await expect(host(page)).toHaveCount(0);
    }
    await track(page, 'relative');
    await page.waitForTimeout(1500);
    const first = (await frameBox(page))?.height ?? 0;
    await page.waitForTimeout(500);
    expect((await frameBox(page))?.height).toBe(first);
    expect(Math.abs(first - viewport.height * 0.9)).toBeLessThanOrEqual(1);
  });
});
