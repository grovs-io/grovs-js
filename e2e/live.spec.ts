/// <reference types="node" />
// Node types are referenced here rather than in tsconfig's `types`, which is
// deliberately empty so a stray `process` or `Buffer` in src/ fails typecheck
// instead of shipping to a browser.
import { expect, test, type Page } from '@playwright/test';

/**
 * Live integration suite — real backend, real project, no stubs.
 *
 * The stub suite proves the SDK builds the right requests. It cannot prove the
 * backend accepts them: a linked domain that does not match, a missing CORS
 * rule, a renamed field, an endpoint that is Enterprise-only. Those only
 * surface against the real thing, which is what this file is for.
 *
 * Credentials come from the environment and are never committed:
 *
 *   GROVS_LIVE_API_KEY   required — a project key from app.grovs.io
 *   GROVS_LIVE_BASE_URL  optional — a self-hosted backend origin
 *   GROVS_LIVE_TEST_ENV  optional — "false" to use production (default: test)
 *
 * Without a key the whole file skips rather than fails, so `npm run verify`
 * stays green for anyone who does not have one.
 *
 * **The project must list this origin as a linked domain**, exactly as
 * printed — the backend compares the string with no normalisation, so
 * `http://localhost:5174` and `localhost:5174` are different values.
 */

const API_KEY = process.env['GROVS_LIVE_API_KEY'];
const BASE_URL = process.env['GROVS_LIVE_BASE_URL'] ?? '';
const TEST_ENV = process.env['GROVS_LIVE_TEST_ENV'] !== 'false';

interface RecordedRequest {
  path: string;
  method?: string;
  body?: Record<string, unknown>;
  status?: number;
  response?: Record<string, unknown> | null;
  keepalive: boolean;
}

async function requests(page: Page): Promise<RecordedRequest[]> {
  return page.evaluate(
    () => (window as unknown as { __grovsRequests?: RecordedRequest[] }).__grovsRequests ?? [],
  );
}

function callsTo(log: RecordedRequest[], path: string): RecordedRequest[] {
  return log.filter((r) => r.path === path);
}

/** Puts the demo in live mode with real credentials before any script runs. */
async function openLive(page: Page, query = ''): Promise<void> {
  await page.addInitScript(
    ([key, base]) => {
      localStorage.setItem(
        'grovs_demo_settings',
        JSON.stringify({ live: true, apiKey: key, baseURL: base }),
      );
    },
    [API_KEY ?? '', BASE_URL],
  );
  await page.goto(`/demo/${query}`);
  await page.getByLabel('testEnvironment').setChecked(TEST_ENV);
}

async function configure(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'configure()' }).click();
  await expect(page.locator('#st-auth'), 'authenticate failed — check the log panel')
    .toHaveText('true', { timeout: 20_000 });
}

test.describe('live backend', () => {
  test.skip(
    !API_KEY,
    'Set GROVS_LIVE_API_KEY to run the live suite. See the comment at the top of this file.',
  );
  // Real network, one project, shared link state — serial keeps the failures
  // legible and avoids hammering the backend from five workers.
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test('authenticates and is issued a visitor identifier', async ({ page }) => {
    await openLive(page);
    await configure(page);

    const auth = callsTo(await requests(page), '/authenticate')[0];
    expect(auth?.status).toBe(200);
    expect(auth?.response?.['linksquared'], 'no visitor id returned').toBeTruthy();

    // The fingerprint the backend matches deferred deep links against.
    expect(auth?.body).toMatchObject({ user_agent: expect.any(String) });
    expect(auth?.body?.['timezone']).toBeTruthy();
    expect(auth?.body?.['screen_width']).toBeTruthy();
  });

  test('rejects an unconfigured origin with a usable message', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'grovs_demo_settings',
        JSON.stringify({ live: true, apiKey: 'definitely-not-a-real-key', baseURL: '' }),
      );
    });
    await page.goto('/demo/');
    await page.getByRole('button', { name: 'configure()' }).click();

    // Whatever the backend refuses on, the SDK must say so rather than fail
    // silently — that is the whole point of onError.
    await expect(page.locator('#log')).toContainText('onError', { timeout: 20_000 });
    await expect(page.locator('#st-auth')).toHaveText('false');
  });

  test('creates a link and reads its details back', async ({ page }) => {
    await openLive(page);
    await configure(page);

    await page.getByRole('button', { name: 'generateLink() all params' }).click();
    await expect(page.locator('#log')).toContainText('generateLink() all params →', {
      timeout: 20_000,
    });

    const created = callsTo(await requests(page), '/create_link')[0];
    expect(created?.status, 'link creation rejected').toBe(200);

    const url = created?.response?.['link'] as string | undefined;
    expect(url, 'backend returned no link — are redirect rules configured?').toBeTruthy();

    // The path is what linkDetails and deep link resolution both key on.
    const path = new URL(url!).pathname.replace(/^\//, '');
    expect(path).not.toBe('');

    const details = await page.evaluate(
      (p) => (window as unknown as { Grovs: { linkDetails(p: string): Promise<unknown> } }).Grovs.linkDetails(p),
      path,
    );
    expect(details, 'linkDetails returned nothing for a link we just made').toBeTruthy();

    // The only check that the clipboard keys were stored rather than ignored:
    // an unpermitted param is dropped silently, so the 200 above proves
    // nothing. The demo enables both previews, so neither flag can be nulled
    // for want of one — a null back here means the key never landed.
    const link = details as Record<string, unknown>;
    expect(
      link['copy_to_clipboard_ios'],
      'copy_to_clipboard_ios not echoed — the backend counterpart may not be deployed here',
    ).toBe(false);
    expect(link['copy_to_clipboard_android']).toBe(true);
  });

  test('resolves a deep link arriving through the query parameter', async ({ page }) => {
    await openLive(page);
    await configure(page);

    await page.getByRole('button', { name: 'generateLink()', exact: true }).click();
    await expect(page.locator('#log')).toContainText('generateLink() →', { timeout: 20_000 });

    const url = callsTo(await requests(page), '/create_link')[0]?.response?.['link'] as
      | string
      | undefined;
    expect(url).toBeTruthy();
    const path = new URL(url!).pathname.replace(/^\//, '');

    // Arrive as a visitor would, carrying the link path.
    await openLive(page, `?Grovs=${encodeURIComponent(path)}`);
    await configure(page);

    // Authentication completes before the path lookup goes out, and the demo
    // records a request before its response arrives — so poll on the status,
    // not the call count, or the assertion races the in-flight request.
    await expect
      .poll(async () => callsTo(await requests(page), '/data_for_device_and_path')[0]?.status, {
        timeout: 20_000,
      })
      .toBe(200);

    const resolution = callsTo(await requests(page), '/data_for_device_and_path')[0];
    expect(resolution?.body?.['path']).toBe(path);
    // The payload we attached when creating it comes back.
    expect(resolution?.response?.['data'], 'no payload returned for the link').toBeTruthy();
  });

  test('delivers a batch of events the backend accepts', async ({ page }) => {
    await openLive(page);
    await configure(page);

    await page.getByRole('button', { name: 'track()', exact: true }).click();
    await page.getByRole('button', { name: 'trackScreenView()' }).click();
    await page.getByRole('button', { name: '/checkout' }).click();
    await page.getByRole('button', { name: 'flush()' }).click();

    // Requests are recorded before their responses arrive: poll the status.
    await expect
      .poll(async () => callsTo(await requests(page), '/events/batch').slice(-1)[0]?.status, {
        timeout: 20_000,
      })
      .toBe(200);

    const batch = callsTo(await requests(page), '/events/batch').slice(-1)[0];

    // Spec B6: 200 does not mean accepted. A rejection here means the wire
    // contract has drifted, which is exactly what this suite is for.
    expect(
      batch?.response?.['rejected'],
      `backend rejected events: ${JSON.stringify(batch?.response?.['errors'])}`,
    ).toBe(0);
    expect(Number(batch?.response?.['accepted'])).toBeGreaterThan(0);
  });

  test('sets user identity and attributes', async ({ page }) => {
    await openLive(page);
    await configure(page);

    await page.getByRole('button', { name: 'setUserIdentifier()' }).click();
    await page.getByRole('button', { name: 'setUserAttributes()' }).click();

    // Poll until every recorded call has its response, not merely started.
    await expect
      .poll(
        async () => {
          const calls = callsTo(await requests(page), '/visitor_attributes');
          return calls.length > 0 && calls.every((c) => c.status !== undefined);
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    for (const call of callsTo(await requests(page), '/visitor_attributes')) {
      expect(call.status).toBe(200);
    }
  });

  test('syncs screen aliases', async ({ page }) => {
    await openLive(page);
    await configure(page);

    await page.getByRole('button', { name: 'setScreenAliases()' }).click();

    await expect
      .poll(async () => callsTo(await requests(page), '/screen_aliases')[0]?.status, {
        timeout: 20_000,
      })
      .toBe(200);
  });

  test('lists messages and reads the unread count', async ({ page }) => {
    await openLive(page);
    await configure(page);

    await page.getByRole('button', { name: 'numberOfUnreadMessages()' }).click();
    await expect(page.locator('#log')).toContainText('numberOfUnreadMessages() →', {
      timeout: 20_000,
    });

    const unread = callsTo(await requests(page), '/number_of_unread_notifications')[0];
    expect(unread?.status).toBe(200);
    expect(typeof unread?.response?.['number_of_unread_notifications']).toBe('number');

    await page.getByRole('button', { name: 'showMessagesList()' }).click();
    await expect
      .poll(async () => callsTo(await requests(page), '/notifications_for_device')[0]?.status, {
        timeout: 20_000,
      })
      .toBe(200);
  });

  test('reports the Enterprise requirement for purchases, or accepts them', async ({ page }) => {
    await openLive(page);
    await configure(page);

    await page.getByRole('button', { name: 'logCustomPurchase()' }).click();
    await expect
      .poll(async () => callsTo(await requests(page), '/add_payment_event')[0]?.status, {
        timeout: 20_000,
      })
      .toBeDefined();

    const purchase = callsTo(await requests(page), '/add_payment_event')[0];

    // Spec B4: the route only exists when the backend runs with GROVS_EE.
    // Both outcomes are correct; silently doing neither is not.
    if (purchase?.status === 404) {
      await expect(page.locator('#log')).toContainText('GROVS_EE');
    } else {
      expect(purchase?.status).toBe(200);
    }
  });

  test('delivers the final time_spent on tab close', async ({ page }) => {
    await openLive(page);
    await configure(page);
    await page.waitForTimeout(1500);

    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

    await expect
      .poll(
        async () =>
          (await requests(page))
            .filter((r) => r.path === '/events/batch' && r.keepalive)
            .flatMap((r) => (r.body?.['events'] as Record<string, unknown>[] | undefined) ?? [])
            .some((e) => e['event'] === 'time_spent'),
        { timeout: 20_000 },
      )
      .toBe(true);
  });

  test('an identified visitor is recognised on a second visit', async ({ page }) => {
    await openLive(page);
    await configure(page);
    const first = callsTo(await requests(page), '/authenticate')[0]?.response?.['linksquared'];

    // Same browser context, so the identity cookie survives. Reopen through
    // openLive, not a bare goto: the fresh page resets the testEnvironment
    // checkbox to its HTML default (checked), and a test-env configure targets
    // the twin project — which issues a different visitor id.
    await openLive(page, '?second=visit');
    await configure(page);
    const second = callsTo(await requests(page), '/authenticate')[0]?.response?.['linksquared'];

    // A different id means the returning visitor was counted as a new install.
    expect(second).toBe(first);
  });
});
