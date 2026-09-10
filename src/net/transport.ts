export interface TransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Set for the pagehide flush in Phase 1. Browsers cap all in-flight
   *  keepalive bodies at 64 KB combined (spec Translations). */
  keepalive?: boolean;
  /**
   * Asked before every retry. The first attempt cannot be recalled, but the
   * two behind it can: consent withdrawn mid-batch would otherwise keep
   * re-sending the same events and the same visitor id for another two
   * attempts, after the SDK was told to stop.
   */
  abandon?: () => boolean;
}

export interface TransportResponse {
  ok: boolean;
  /** 0 means the request never reached a server — DNS, offline, CORS. */
  status: number;
  body: unknown;
  /** From a Retry-After header, when the server sent one. Callers that queue
   *  hold off at least this long before trying again. */
  retryAfterMs?: number;
}

/**
 * The seam that keeps handlers off `fetch` (spec A2). Tests inject
 * FakeTransport and assert on a recorded request log rather than mocking a
 * global.
 */
export interface Transport {
  send(req: TransportRequest): Promise<TransportResponse>;
}
