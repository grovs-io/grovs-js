import type { Transport, TransportRequest, TransportResponse } from './transport';

const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

/** 5xx and network failures are worth retrying; 4xx never is. */
function isRetryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

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
    // keepalive requests fire during unload; there is no time to retry, and a
    // retry would race the page going away.
    const attempts = req.keepalive ? 1 : MAX_ATTEMPTS;
    let last: TransportResponse = { ok: false, status: 0, body: null };

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      last = await this.attempt(req);
      if (last.ok || !isRetryable(last.status)) return last;

      if (attempt < attempts - 1) {
        // Exponential backoff with full jitter: without the jitter, every tab
        // that failed together retries together and rebuilds the spike that
        // caused the failure.
        const ceiling = BASE_BACKOFF_MS * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
      }
    }

    return last;
  }

  private async attempt(req: TransportRequest): Promise<TransportResponse> {
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
    };
    if (req.method !== 'GET' && req.body !== undefined) {
      init.body = JSON.stringify(req.body);
    }
    if (req.keepalive) init.keepalive = true;

    // A request with no timeout can hang for the tab's lifetime, and the
    // events handler's `sending` guard means one hung request blocks the queue
    // permanently.
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), TIMEOUT_MS)
      : null;
    if (controller) init.signal = controller.signal;

    try {
      const response = await fetch(req.url, init);

      // The body read stays inside the timeout: a server that answers headers
      // promptly and then trickles the body would otherwise hang past it.
      let body: unknown = null;
      try {
        const text = await response.text();
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        body = null;
      }

      return { ok: response.ok, status: response.status, body };
    } catch {
      return { ok: false, status: 0, body: null };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
