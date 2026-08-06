import type { Transport, TransportRequest, TransportResponse } from './transport';

/**
 * Replaces v1's XMLHttpRequest. fetch is the only transport that can set the
 * three auth headers *and* survive page unload via keepalive — sendBeacon
 * cannot set headers at all.
 *
 * Never throws: a rejected fetch becomes status 0, so every caller branches on
 * one shape instead of mixing try/catch with status checks.
 */
export class FetchTransport implements Transport {
  async send(req: TransportRequest): Promise<TransportResponse> {
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
    };
    if (req.method !== 'GET' && req.body !== undefined) {
      init.body = JSON.stringify(req.body);
    }
    if (req.keepalive) init.keepalive = true;

    let response: Response;
    try {
      response = await fetch(req.url, init);
    } catch {
      return { ok: false, status: 0, body: null };
    }

    let body: unknown = null;
    try {
      const text = await response.text();
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }

    return { ok: response.ok, status: response.status, body };
  }
}
