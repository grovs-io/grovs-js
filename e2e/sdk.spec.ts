import { expect, test, type Page } from '@playwright/test';

interface RecordedRequest {
  path: string;
  method?: string;
  body?: Record<string, unknown>;
  keepalive: boolean;
}

async function requests(page: Page): Promise<RecordedRequest[]> {
  return page.evaluate(
    () => (window as unknown as { __grovsRequests?: RecordedRequest[] }).__grovsRequests ?? [],
  );
}

async function configure(page: Page, url = '/demo/'): Promise<void> {
  await page.goto(url);
  await page.getByRole('button', { name: 'configure()' }).click();
  await expect(page.locator('#st-auth')).toHaveText('true');
}

test.describe('Grovs SDK end to end', () => {
  // Flow 1: the deep link parameter is captured and still resolvable after a
  // reload, which is what deferred attribution depends on.
  test('captures a deep link parameter and keeps it across a reload', async ({ page }) => {
    await configure(page, '/demo/?Grovs=abc123');

    const first = await requests(page);
    const pathCall = first.find((r) => r.path === '/data_for_device_and_path');
    expect(pathCall?.body?.['path']).toBe('abc123');

    await page.reload();
    await page.getByRole('button', { name: 'configure()' }).click();
    await expect(page.locator('#st-auth')).toHaveText('true');

    const second = await requests(page);
    expect(second.find((r) => r.path === '/data_for_device_and_path')?.body?.['path']).toBe(
      'abc123',
    );
  });

  // Flow 2: identity survives navigation, which is what stops a returning
  // visitor being recounted as an install.
  test('persists the visitor identifier across navigation', async ({ page }) => {
    await configure(page);

    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === 'linksquared')?.value).toBe('demo-visitor-1');

    await page.goto('/demo/?second=visit');
    const mirrored = await page.evaluate(() => localStorage.getItem('linksquared'));
    expect(mirrored).toBe('demo-visitor-1');
  });

  // Flow 3: SPA route changes fire screen views carrying the post-navigation
  // title, which is the whole point of the one-frame deferral.
  test('fires screen views on SPA route changes', async ({ page }) => {
    await configure(page);
    await page.getByRole('button', { name: 'setScreenAliases()' }).click();

    await page.getByRole('button', { name: '/checkout' }).click();
    await page.getByRole('button', { name: '/product/42' }).click();
    await page.getByRole('button', { name: 'flush()' }).click();

    const batches = (await requests(page)).filter((r) => r.path === '/events/batch');
    const events = batches.flatMap(
      (r) => (r.body?.['events'] as Record<string, unknown>[] | undefined) ?? [],
    );
    const screens = events
      .filter((e) => e['event_name'] === 'screen_view')
      .map((e) => (e['properties'] as Record<string, string>)?.['screen_name']);

    expect(screens).toContain('Checkout');
    expect(screens).toContain('Product');
  });

  // Flow 4: the modal must not leak styles into the host page, nor inherit
  // them — the reason it moved into a shadow root.
  test('renders the messages modal inside a shadow root', async ({ page }) => {
    await configure(page);
    await page.getByRole('button', { name: 'showMessagesList()' }).click();

    await expect(page.locator('#Grovs-modal')).toBeAttached();

    // Playwright's locators pierce shadow roots by design, so the isolation
    // claim has to be checked with the real DOM API the host page would use.
    const visibility = await page.evaluate(() => ({
      fromHostDocument: document.querySelectorAll('.grovs-item').length,
      fromShadowRoot:
        document.getElementById('Grovs-modal')?.shadowRoot?.querySelectorAll('.grovs-item')
          .length ?? 0,
    }));
    expect(visibility).toEqual({ fromHostDocument: 0, fromShadowRoot: 2 });

    // The other half of isolation: host CSS must not reach in. v1 injected
    // raw markup into the page, so it inherited whatever the host had.
    const styled = await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '.grovs-item { display: none !important; }';
      document.head.appendChild(style);
      const row = document
        .getElementById('Grovs-modal')
        ?.shadowRoot?.querySelector('.grovs-item') as HTMLElement | null;
      return row ? getComputedStyle(row).display : 'missing';
    });
    expect(styled).toBe('flex');

    const fontRequests = await page.evaluate(
      () => document.querySelectorAll('link[href*="fonts.googleapis.com"]').length,
    );
    expect(fontRequests).toBe(0);
  });

  // Flow 5: queued events survive going offline and drain when the network
  // returns, rather than being lost.
  test('drains the queue after reconnecting', async ({ page, context }) => {
    await configure(page);

    await context.setOffline(true);
    await page.getByRole('button', { name: 'track()', exact: true }).click();
    await page.getByRole('button', { name: 'flush()' }).click();

    await context.setOffline(false);
    await page.getByRole('button', { name: 'flush()' }).click();

    const events = (await requests(page))
      .filter((r) => r.path === '/events/batch')
      .flatMap((r) => (r.body?.['events'] as Record<string, unknown>[] | undefined) ?? []);
    expect(events.some((e) => e['event_name'] === 'purchase')).toBe(true);
  });

  // Flow 6: the IIFE build must expose a working global from a bare script
  // tag, which is the whole CDN story.
  test('exposes window.Grovs from a plain script tag', async ({ page }) => {
    await page.goto('/e2e/iife.html');
    const surface = await page.evaluate(() => {
      const g = (window as unknown as { Grovs?: Record<string, unknown> }).Grovs;
      return {
        configure: typeof g?.['configure'],
        track: typeof g?.['track'],
        v1: typeof g?.['V1'],
        version: g?.['SDK_VERSION'],
      };
    });

    const errorCodes = await page.evaluate(() => {
      const g = (window as unknown as { Grovs?: Record<string, unknown> }).Grovs;
      return g?.['GrovsError'] as Record<string, number> | undefined;
    });
    expect(errorCodes?.['authenticationFailed']).toBe(1);
    // Named exports must survive the IIFE wrapper too: the README tells
    // script-tag users to compare against GrovsError rather than raw numbers.
    expect(surface).toEqual({
      configure: 'function',
      track: 'function',
      v1: 'function',
      version: '2.0',
    });
  });

  // Flow 7, the one that is not optional: closing the tab must deliver the
  // final time_spent. jsdom has neither a page lifecycle nor keepalive, so
  // a unit test there asserts against a mock of the exact thing that breaks.
  test('delivers the final time_spent on tab close', async ({ page }) => {
    await configure(page);
    await page.waitForTimeout(1200);

    // Playwright cannot observe a request from a page that is gone, so the
    // page records it before unload completes.
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

    const events = (await requests(page))
      .filter((r) => r.path === '/events/batch')
      .flatMap((r) =>
        ((r.body?.['events'] as Record<string, unknown>[] | undefined) ?? []).map(
          (e): Record<string, unknown> => ({ ...e, keepalive: r.keepalive }),
        ),
      );

    const timeSpent = events.find((e) => e['event'] === 'time_spent');
    expect(timeSpent, 'no time_spent event was sent on pagehide').toBeTruthy();
    expect(timeSpent?.['keepalive']).toBe(true);
    expect(Number(timeSpent?.['engagement_time'])).toBeGreaterThan(0);
  });

  // The byte-budget branch: oversized custom events must not crowd out the
  // system event, because time_spent cannot be retried — its session is over.
  test('keeps time_spent within the keepalive budget despite fat events', async ({ page }) => {
    await configure(page);

    for (let i = 0; i < 10; i += 1) {
      await page.getByRole('button', { name: 'track() 9 KB props' }).click();
    }
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

    const exitBatch = (await requests(page))
      .filter((r) => r.path === '/events/batch' && r.keepalive)
      .pop();

    const events = (exitBatch?.body?.['events'] as Record<string, unknown>[] | undefined) ?? [];

    // The claim is not that time_spent is first — install legitimately
    // precedes it — but that every system event ships ahead of the custom
    // ones, so 80 KB of properties cannot crowd out the event that cannot be
    // retried.
    const firstCustom = events.findIndex((e) => e['event_name'] !== undefined);
    const lastSystem = events.map((e) => e['event'] !== undefined).lastIndexOf(true);
    if (firstCustom !== -1) expect(lastSystem).toBeLessThan(firstCustom);

    expect(events.some((e) => e['event'] === 'time_spent')).toBe(true);
    expect(JSON.stringify(events).length).toBeLessThan(64 * 1024);
  });

  test('reports the Enterprise requirement for purchases', async ({ page }) => {
    await configure(page);
    await page.getByRole('button', { name: 'logCustomPurchase()' }).click();
    await expect(page.locator('#log')).toContainText('GROVS_EE');
  });
});
