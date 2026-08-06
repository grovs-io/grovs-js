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

  it('passes keepalive through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const t = new FetchTransport();
    await t.send({ method: 'POST', url: 'https://x.com', headers: {}, keepalive: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.keepalive).toBe(true);
  });
});
