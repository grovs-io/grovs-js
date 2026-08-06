export interface TransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Set for the pagehide flush in Phase 1. Browsers cap all in-flight
   *  keepalive bodies at 64 KB combined (spec Translations). */
  keepalive?: boolean;
}

export interface TransportResponse {
  ok: boolean;
  /** 0 means the request never reached a server — DNS, offline, CORS. */
  status: number;
  body: unknown;
}

/**
 * The seam that keeps handlers off `fetch` (spec A2). Tests inject
 * FakeTransport and assert on a recorded request log rather than mocking a
 * global.
 */
export interface Transport {
  send(req: TransportRequest): Promise<TransportResponse>;
}
