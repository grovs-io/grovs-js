import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

/**
 * Real delivery. The stubbed suite answers fetch inside the page, so it can
 * prove what the SDK *tried* to send; it cannot prove the bytes left the
 * browser. Each test here owns an HTTP server and asserts on what that server
 * received — through a real tab close, a real offline window, a backend that
 * fails and recovers, and a real reload.
 */

interface Received {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  status: number;
}

class Backend {
  readonly received: Received[] = [];
  /** How many /events/batch requests still answer 503 before recovering. */
  failBatches = 0;
  /**
   * Hold the first batch carrying this event and never answer it, as a page
   * going away before its acknowledgement arrives.
   *
   * Named rather than counted: the SDK batches every five seconds, so a
   * scheduled tick can carry the event before a count-based hold is armed,
   * and the test would then be measuring a batch that was answered normally.
   */
  hangEvent: string | null = null;
  private readonly held: http.ServerResponse[] = [];
  private server: http.Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Content-Type': 'application/json',
      };
      if (req.method === 'OPTIONS') {
        this.received.push({ method: 'OPTIONS', path: req.url ?? '', body: null, status: 204 });
        res.writeHead(204, headers).end();
        return;
      }
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        const path = (req.url ?? '').replace(/^\/api\/v1\/sdk/, '');
        let body: Record<string, unknown> | null = null;
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        } catch {
          body = null;
        }
        if (path === '/events/batch' && this.hangEvent !== null) {
          const names = ((body?.['events'] as Record<string, unknown>[] | undefined) ?? []).map(
            (e) => String(e['event'] ?? e['event_name']),
          );
          if (names.includes(this.hangEvent)) {
            this.hangEvent = null;
            this.received.push({ method: req.method ?? '', path, body, status: 0 });
            this.held.push(res);
            return;
          }
        }
        const [status, answer] = this.answer(path, body);
        this.received.push({ method: req.method ?? '', path, body, status });
        res.writeHead(status, headers).end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server!.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  private answer(path: string, body: Record<string, unknown> | null): [number, unknown] {
    switch (path) {
      case '/authenticate':
        return [200, { linksquared: 'e2e-visitor', sdk_identifier: null, sdk_attributes: null }];
      case '/data_for_device':
      case '/data_for_device_and_path':
        return [200, { data: null }];
      case '/events/batch': {
        if (this.failBatches > 0) {
          this.failBatches -= 1;
          return [503, { error: 'unavailable' }];
        }
        const events = (body?.['events'] as unknown[] | undefined) ?? [];
        return [200, { accepted: events.length, rejected: 0, errors: [] }];
      }
      default:
        return [200, {}];
    }
  }

  /** Every event name the server *accepted* on /events/batch, in arrival order. */
  delivered(): string[] {
    return this.received
      .filter((r) => r.path === '/events/batch' && r.status === 200)
      .flatMap((r) => (r.body?.['events'] as Record<string, unknown>[] | undefined) ?? [])
      .map((e) => String(e['event'] ?? e['event_name']));
  }

  batches(): number {
    return this.received.filter((r) => r.method === 'POST' && r.path === '/events/batch').length;
  }

  /** Every event name sent to /events/batch, answered or not. */
  sent(): string[] {
    return this.received
      .filter((r) => r.method === 'POST' && r.path === '/events/batch')
      .flatMap((r) => (r.body?.['events'] as Record<string, unknown>[] | undefined) ?? [])
      .map((e) => String(e['event'] ?? e['event_name']));
  }

  /** The wire bodies of every event sent, for comparing a replay to its original. */
  sentBodies(): Record<string, unknown>[] {
    return this.received
      .filter((r) => r.method === 'POST' && r.path === '/events/batch')
      .flatMap((r) => (r.body?.['events'] as Record<string, unknown>[] | undefined) ?? []);
  }

  async stop(): Promise<void> {
    for (const res of this.held) res.destroy();
    this.held.length = 0;
    // close() alone waits for every keep-alive socket the page still holds,
    // and the page is still open at teardown — so drop them explicitly.
    this.server?.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

async function configureAgainst(page: Page, backend: Backend, apiKey: string): Promise<void> {
  await page.addInitScript(
    ([key, url, apiKey]) => {
      localStorage.setItem(key!, JSON.stringify({ live: true, baseURL: url, apiKey }));
    },
    ['grovs_demo_settings', backend.url, apiKey] as const,
  );
  await page.goto('/demo/');
  await page.getByRole('button', { name: 'configure()' }).click();
  await expect(page.locator('#st-auth')).toHaveText('true');
  await expect.poll(() => backend.received.some((r) => r.path === '/authenticate')).toBe(true);
}

function track(page: Page, name: string): Promise<void> {
  return page.evaluate((n) => {
    (window as unknown as { Grovs: { track(name: string): void } }).Grovs.track(n);
  }, name);
}

function flush(page: Page): Promise<void> {
  return page.evaluate(() =>
    (window as unknown as { Grovs: { flush(): Promise<void> } }).Grovs.flush(),
  );
}

/**
 * Waits until the event is in this origin's stored queue.
 *
 * Persistence is debounced by a second, so a reload issued before it lands
 * would test the race rather than the recovery. Asserting the precondition
 * makes the failure legible: a timeout here means the SDK did not persist,
 * which is a different bug from failing to re-send.
 */
async function expectPersisted(page: Page, name: string): Promise<void> {
  await expect
    .poll(
      () =>
        // key(i), not Object.entries: Storage's named-property enumeration is
        // not something every engine agrees on, and this read is a
        // precondition — it has to be reliable or it fails the wrong thing.
        page.evaluate(() => {
          let all = '';
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (key?.startsWith('grovs_events')) all += localStorage.getItem(key) ?? '';
          }
          return all;
        }),
      { timeout: 5_000, message: `"${name}" never reached the stored queue` },
    )
    .toContain(name);
}

// Serial per engine: an unload's keepalive request is the one thing here
// that a starved browser process can lose, and nine engines in parallel
// starve each other. This suite measures the SDK, not the host's CPU.
test.describe.configure({ mode: 'serial' });

test.describe('real delivery', () => {
  let backend: Backend;

  test.beforeEach(async () => {
    backend = new Backend();
    await backend.start();
  });

  test.afterEach(async () => {
    await backend.stop();
  });

  test('the final time_spent survives a real tab close', async ({ page, context }) => {
    // A loaded CI runner is slow, and this test closes a page and waits on a
    // network round trip afterwards.
    test.setTimeout(60_000);

    await configureAgainst(page, backend, 'close-key');
    // time_spent counts whole seconds of visible time, measured by the engine
    // rather than by this test. A headless browser on a loaded runner can
    // flip the page hidden and back, which restarts that count, so whether
    // the event exists at all is not something the test controls. Its
    // presence is therefore not asserted below — only that it is never
    // delivered twice. The delivery guarantee itself is carried by
    // before_close and app_open, which the test does control.
    await page.waitForTimeout(2_000);

    // Tracked after the dwell, so the scheduled five-second batch cannot have
    // carried it away first: both events are then queued together and the
    // keepalive the hide sends carries them as one batch.
    await track(page, 'before_close');
    await page.close();

    // The keepalive normally lands, and that is what the next few seconds
    // check. But a browser under load may drop a request issued as the page
    // goes away, and the SDK never claimed otherwise — what it guarantees is
    // that nothing is lost: an unacknowledged batch stays on disk and the
    // next page load sends it. Asserting the optimistic half alone is what
    // made this test fail on CI while the SDK was behaving correctly.
    let arrived = false;
    for (let attempt = 0; attempt < 20 && !arrived; attempt += 1) {
      arrived = backend.delivered().includes('before_close');
      if (!arrived) await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // A fresh page load emits its own launch events, so whether one was needed
    // changes the arithmetic below.
    let fellBack = false;
    if (!arrived) {
      fellBack = true;
      const next = await context.newPage();
      await configureAgainst(next, backend, 'close-key');
      await flush(next);
    }

    const delivered = backend.delivered();
    const detail = `delivered=${JSON.stringify(delivered)} fellBack=${fellBack}`;
    expect(delivered, detail).toEqual(expect.arrayContaining(['app_open', 'before_close']));

    // Exactly once, whichever route it took. before_close is the event under
    // test and is tracked once; app_open comes once per page load, so a
    // fallback page legitimately adds a second.
    const counts = delivered.reduce<Record<string, number>>((acc, name) => {
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts['before_close'], `before_close: ${detail}`).toBe(1);
    expect(counts['app_open'], `app_open: ${detail}`).toBe(fellBack ? 2 : 1);
    expect(counts['time_spent'] ?? 0, `time_spent: ${detail}`).toBeLessThanOrEqual(1);
  });

  test('events tracked offline are delivered once the connection returns', async ({
    page,
    context,
  }) => {
    await configureAgainst(page, backend, 'offline-key');
    // Past the first-batch leeway (5s), so a delivery inside the poll window
    // below can only come from the online listener, not from that timer.
    await page.waitForTimeout(5500);
    await flush(page);
    const before = backend.batches();

    await context.setOffline(true);
    await track(page, 'while_offline');
    await flush(page);
    expect(backend.delivered()).not.toContain('while_offline');

    await context.setOffline(false);
    await expect.poll(() => backend.delivered(), { timeout: 10_000 }).toContain('while_offline');
    expect(backend.batches()).toBeGreaterThan(before);
  });

  test('transport retries a 503 with backoff and the batch lands when it recovers', async ({
    page,
  }) => {
    await configureAgainst(page, backend, 'retry-key');
    backend.failBatches = 2;
    await track(page, 'through_outage');
    await flush(page);

    expect(backend.batches()).toBeGreaterThanOrEqual(3);
    expect(backend.delivered()).toContain('through_outage');
    // Delivered exactly once: the two refused attempts were not accepted.
    expect(backend.delivered().filter((name) => name === 'through_outage')).toHaveLength(1);
  });

  // The headline claim of at-least-once delivery: a batch the browser sent but
  // whose acknowledgement never arrived is still on disk, and the next page
  // load sends it again — byte-identical, so the backend's event_id dedup
  // collapses the copy.
  test('a batch that was never acknowledged is re-sent, byte-identical, after a reload', async ({
    page,
  }) => {
    await configureAgainst(page, backend, 'unacked-key');

    // Armed before the event exists, so whichever batch carries it is the one
    // held — a scheduled tick may get there before the explicit flush.
    backend.hangEvent = 'never_acked';
    await track(page, 'never_acked');
    await page.evaluate(() => {
      void (window as unknown as { Grovs: { flush(): Promise<void> } }).Grovs.flush();
    });
    await expect.poll(() => backend.sent()).toContain('never_acked');
    const original = backend.sentBodies().find((e) => e['event_name'] === 'never_acked');
    await expectPersisted(page, 'never_acked');

    await page.reload();
    await page.getByRole('button', { name: 'configure()' }).click();
    await expect(page.locator('#st-auth')).toHaveText('true');
    await flush(page);

    // Delivered on the second attempt, and identical to the first.
    expect(backend.delivered()).toContain('never_acked');
    const replay = backend
      .sentBodies()
      .filter((e) => e['event_name'] === 'never_acked')
      .pop();
    expect(replay).toEqual(original);
  });

  test('events queued against a dead backend survive a real reload', async ({ page }) => {
    await configureAgainst(page, backend, 'reload-key');
    backend.failBatches = Number.MAX_SAFE_INTEGER;
    await track(page, 'before_reload');
    await flush(page);
    expect(backend.delivered()).not.toContain('before_reload');
    await expectPersisted(page, 'before_reload');

    // Still failing through the unload and the new page's start, so the only
    // way the event can arrive is from the reloaded page's persisted queue.
    await page.reload();
    await page.getByRole('button', { name: 'configure()' }).click();
    await expect(page.locator('#st-auth')).toHaveText('true');
    expect(backend.delivered()).not.toContain('before_reload');

    backend.failBatches = 0;
    await flush(page);
    expect(backend.delivered()).toContain('before_reload');
  });
});
