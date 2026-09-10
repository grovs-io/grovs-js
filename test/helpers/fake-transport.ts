import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../src/net/transport';

/**
 * Records every request and replays queued responses in order.
 *
 * Plays the role MockURLProtocol and MockAPIService play in the iOS test
 * suite: assertions run against what the SDK *sent*, not against a mocked
 * method having been called.
 */
export class FakeTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  private readonly queue: TransportResponse[] = [];
  /** Used when the queue is empty. */
  fallback: TransportResponse = { ok: true, status: 200, body: {} };

  enqueue(response: TransportResponse): this {
    this.queue.push(response);
    return this;
  }

  enqueueStatus(status: number, body: unknown = {}): this {
    return this.enqueue({ ok: status >= 200 && status < 300, status, body });
  }

  /** When set, the next request resolves with this promise instead: for
   *  tests that need a response to arrive after something else happened. */
  hold: Promise<TransportResponse> | null = null;

  send(req: TransportRequest): Promise<TransportResponse> {
    this.requests.push(req);
    const held = this.hold;
    if (held) {
      this.hold = null;
      return held;
    }
    return Promise.resolve(this.queue.shift() ?? this.fallback);
  }

  /** The most recent request, for one-call assertions. */
  get last(): TransportRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  requestsTo(pathSuffix: string): TransportRequest[] {
    return this.requests.filter((r) => r.url.endsWith(pathSuffix));
  }
}
