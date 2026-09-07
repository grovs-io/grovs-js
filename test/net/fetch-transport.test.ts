import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchTransport } from '../../src/net/fetch-transport';

describe('FetchTransport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends method, headers and a JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const t = new FetchTransport();
    const res = await t.send({
      method: 'POST',
      url: 'https://example.com/x',
      headers: { 'PROJECT-KEY': 'k' },
      body: { a: 1 },
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/x');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['PROJECT-KEY']).toBe('k');
  });

  it('omits the body on GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const t = new FetchTransport();
    await t.send({ method: 'GET', url: 'https://example.com/x', headers: {} });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it('reports ok:false for a non-2xx status without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Missing credentials' }), { status: 403 }),
      ),
    );

    const t = new FetchTransport();
    const res = await t.send({ method: 'POST', url: 'https://example.com/x', headers: {} });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Missing credentials' });
  });

  it('returns status 0 when the network rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const t = new FetchTransport();
    const res = await t.send({ method: 'POST', url: 'https://example.com/x', headers: {} });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
  });

  it('tolerates a non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })));

    const t = new FetchTransport();
    const res = await t.send({ method: 'GET', url: 'https://example.com/x', headers: {} });
    expect(res.ok).toBe(false);
    expect(res.body).toBeNull();
  });

  // isRetryable(0) covers refused connections and our own 15 s abort alike.
  // Every caller POSTs, so retrying an abort risks a second purchase.
  it('does not retry after its own timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = new FetchTransport().send({
      method: 'POST',
      url: 'https://example.com/x',
      headers: {},
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const res = await pending;

    expect(res.status).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // sendChunks drops an accepted batch, and configure() reports authenticated:
  // both read `ok`, so a 200 nobody could read must not present as success.
  it('reports a 200 whose body could not be read as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error('aborted mid-body')),
      })),
    );

    const res = await new FetchTransport().send({
      method: 'POST',
      url: 'https://example.com/x',
      headers: {},
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  // The attempt in flight cannot be recalled; the two behind it can. Consent
  // withdrawn mid-batch used to keep re-sending the same events and the same
  // visitor id for another two attempts.
  it('stops retrying when the caller abandons it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await new FetchTransport().send({
      method: 'POST',
      url: 'https://example.com/x',
      headers: {},
      abandon: () => true,
    });

    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The backoff is most of the window: a withdrawal during it must not be
  // followed by the very request it revoked.
  it('re-checks after the backoff, not only before it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    let asked = 0;
    await new FetchTransport().send({
      method: 'POST',
      url: 'https://example.com/x',
      headers: {},
      // Live when the attempt fails, revoked while the backoff runs.
      abandon: () => {
        asked += 1;
        return asked > 1;
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries three times when it is not abandoned', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await new FetchTransport().send({
      method: 'POST',
      url: 'https://example.com/x',
      headers: {},
      abandon: () => false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('passes keepalive through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const t = new FetchTransport();
    await t.send({ method: 'POST', url: 'https://x.com', headers: {}, keepalive: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.keepalive).toBe(true);
  });
});
