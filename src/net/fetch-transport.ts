import type { Transport, TransportRequest, TransportResponse } from './transport';

const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
/** A server can ask for minutes; a page load does not have minutes. Anything
 *  past this is left to the caller's own queue and its next tick. */
const MAX_RETRY_AFTER_WAIT_MS = 5_000;
/** Retry-After is either seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

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
    // Serialized once, before the loop: it cannot succeed on a retry it
    // failed on, and re-encoding a 50-event batch per attempt is wasted work
    // on the main thread. A failure here is deterministic, so it returns
    // without entering the loop at all.
    let body: string | undefined;
    if (req.method !== 'GET' && req.body !== undefined) {
      try {
        body = JSON.stringify(req.body);
      } catch {
        return { ok: false, status: 0, body: null };
      }
    }

    // keepalive requests fire during unload; there is no time to retry, and a
    // retry would race the page going away.
    const attempts = req.keepalive ? 1 : MAX_ATTEMPTS;
    let last: TransportResponse = { ok: false, status: 0, body: null };

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const outcome = await this.attempt(req, body);
      last = outcome.response;
      if (last.ok || !isRetryable(last.status)) return last;

      // Our own timeout, not a refused connection: the server may well have
      // processed the request. Every caller here POSTs, so a retry risks a
      // second purchase or a second link. Events lose nothing — they stay
      // queued for the next tick.
      if (outcome.timedOut) return last;

      // Consent withdrawn, or the client retired, since the attempt started.
      if (req.abandon?.()) return last;

      // A delay longer than this request is willing to hold means the answer
      // is "not now", not "in five seconds". Waiting the cap and retrying
      // anyway is the amplification the header exists to prevent. Give up
      // here; the caller queues, and its own cooldown carries the full delay.
      const asked = last.retryAfterMs ?? 0;
      if (asked > MAX_RETRY_AFTER_WAIT_MS) return last;

      if (attempt < attempts - 1) {
        // Exponential backoff with full jitter: without the jitter, every tab
        // that failed together retries together and rebuilds the spike that
        // caused the failure. A shorter server-named delay still outranks it.
        const ceiling = BASE_BACKOFF_MS * 2 ** attempt;
        const jittered = Math.random() * ceiling;
        await new Promise((resolve) => setTimeout(resolve, Math.max(jittered, asked)));

        // Asked again on the far side of the wait: the backoff is most of the
        // window, so a consent withdrawal during it would otherwise be
        // followed by the very request it revoked.
        if (req.abandon?.()) return last;
      }
    }

    return last;
  }

  private async attempt(
    req: TransportRequest,
    body: string | undefined,
  ): Promise<{ response: TransportResponse; timedOut: boolean }> {
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
    };
    if (body !== undefined) init.body = body;
    if (req.keepalive) init.keepalive = true;

    // A request with no timeout can hang for the tab's lifetime, and the
    // events handler's `sending` guard means one hung request blocks the queue
    // permanently.
    let timedOut = false;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, TIMEOUT_MS)
      : null;
    if (controller) init.signal = controller.signal;

    try {
      const response = await fetch(req.url, init);

      // The body read stays inside the timeout: a server that answers headers
      // promptly and then trickles the body would otherwise hang past it.
      let body: unknown = null;
      let unreadable = false;
      try {
        const text = await response.text();
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        unreadable = true;
      }

      // A 200 nobody could read is not a success: the events handler would
      // drop the batch as accepted and configure() would report an identity it
      // never received. Not retried — the server did process it.
      if (unreadable && response.ok) {
        return { response: { ok: false, status: response.status, body: null }, timedOut };
      }

      const result: TransportResponse = { ok: response.ok, status: response.status, body };
      const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after') ?? null);
      if (retryAfter !== null) result.retryAfterMs = retryAfter;
      return { response: result, timedOut };
    } catch {
      return { response: { ok: false, status: 0, body: null }, timedOut };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
