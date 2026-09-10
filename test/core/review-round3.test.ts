import { describe, expect, it, vi } from 'vitest';
import { GrovsClient } from '../../src/core/client';
import { PersistedQueue, QUEUE_STORAGE_KEY } from '../../src/storage/persisted-queue';
import { ScreenAliases } from '../../src/tracking/screen-aliases';
import { Logger } from '../../src/logging/logger';
import { sanitizeProperties } from '../../src/events/sanitize';
import { scopedKey } from '../../src/storage/scoped-storage';
import type { QueuedEvent } from '../../src/events/event';
import { FakeTransport } from '../helpers/fake-transport';
import { FakeStorage } from '../helpers/fake-storage';
import { FakeClock } from '../helpers/fake-clock';

const AUTH_OK = { ok: true, status: 200, body: { linksquared: 'v1' } };
const PAYLOAD_NONE = { ok: true, status: 200, body: { data: null } };

function event(id: string, at: number, size = 900): QueuedEvent {
  return { id, eventName: 'e', createdAt: at, sessionId: 's', properties: { p: 'x'.repeat(size) } };
}

describe('PersistedQueue limits', () => {
  it('does not double-count events evicted by the count cap', () => {
    const storage = new FakeStorage();
    const snapshot = Array.from({ length: 1500 }, (_, i) => event(`e${i}`, i));
    storage.set(QUEUE_STORAGE_KEY, JSON.stringify(snapshot));
    const queue = new PersistedQueue(storage, new FakeClock());
    expect(queue.size()).toBe(1000);
  });

  it('does not resurrect a delivered event when merging from storage', () => {
    const storage = new FakeStorage();
    const queue = new PersistedQueue(storage, new FakeClock());
    queue.add(event('sent', 1));
    queue.remove(['sent']);
    storage.set(QUEUE_STORAGE_KEY, JSON.stringify([event('sent', 1)]));
    queue.mergeFromStorage();
    expect(queue.all().map((e) => e.id)).not.toContain('sent');
  });

  it('reports a refused write once', () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const dropped = vi.fn();
    const queue = new PersistedQueue(storage, new FakeClock(), dropped);
    queue.add(event('a', 1));
    queue.flushToStorage();
    queue.add(event('b', 2));
    queue.flushToStorage();
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledWith(0, expect.stringContaining('refused'));
  });
});

describe('a failing backend is not amplified', () => {
  it('a full queue against a rejecting backend sends once per interval, not per event', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    transport.fallback = { ok: false, status: 400, body: {} };
    const clock = new FakeClock();
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), clock, autoStartEvents: false },
    );
    await client.configure();
    client.eventsHandler.onPathResolved(null);

    for (let i = 0; i < 100; i += 1) client.track(`e${i}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.requestsTo('/events/batch')).toHaveLength(1);

    clock.advance(30_000);
    client.track('later');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.requestsTo('/events/batch')).toHaveLength(2);
    client.dispose();
  });
});

describe('sanitizer bounds its own work', () => {
  it('gives up on a shared-reference graph instead of expanding it', () => {
    let node: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 30; i += 1) node = { a: node, b: node };
    const started = performance.now();
    const result = sanitizeProperties({ graph: node });
    expect(performance.now() - started).toBeLessThan(200);
    expect(result).toBeUndefined();
  });
});

describe('alias precedence', () => {
  it('a bare catch-all loses to any route pattern', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '*': 'Other', '/:org/:repo/:tab': 'Repo' });
    expect(aliases.resolve('/acme/widgets/issues')).toBe('Repo');
    expect(aliases.resolve('/about')).toBe('Other');
  });
});

describe('reset() clears durable state it never opened', () => {
  it('removes a previous visit\'s identifier and queue while consent is pending', () => {
    localStorage.clear();
    localStorage.setItem('linksquared', 'old-visitor');
    localStorage.setItem(scopedKey('grovs_events', 'k'), '[{"id":"x"}]');
    localStorage.setItem('grovs_events', '[{"id":"legacy"}]');
    document.cookie = 'linksquared=old-visitor;path=/';
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport: new FakeTransport(), autoStartEvents: false },
    );
    client.reset();
    expect(localStorage.getItem('linksquared')).toBeNull();
    expect(localStorage.getItem(scopedKey('grovs_events', 'k'))).toBeNull();
    expect(localStorage.getItem('grovs_events')).toBeNull();
    expect(document.cookie).not.toContain('old-visitor');
    client.dispose();
  });
});

describe('reset() in another tab', () => {
  it('stops this tab sending as the erased visitor', async () => {
    localStorage.clear();
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient({ apiKey: 'k' }, { transport });
    await client.configure();
    expect(client.isAuthenticated()).toBe(true);
    // The opening batch leaves as soon as attribution settles, so measure
    // from here: what matters is that nothing more goes out after the reset.
    const beforeReset = transport.requestsTo('/events/batch').length;

    window.dispatchEvent(
      new StorageEvent('storage', { key: 'linksquared', oldValue: 'v1', newValue: null }),
    );
    expect(client.isAuthenticated()).toBe(false);
    client.track('after');
    await client.flush();
    expect(transport.requestsTo('/events/batch')).toHaveLength(beforeReset);
    client.dispose();
    localStorage.clear();
  });
});

describe('authentication retries after a transient failure', () => {
  it('re-authenticates when the browser comes back online, and stops after success', async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const transport = new FakeTransport();
      transport.enqueueStatus(0).enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
      const client = new GrovsClient(
        { apiKey: 'k', onError },
        { transport, storage: new FakeStorage(), autoStartEvents: false },
      );
      await expect(client.configure()).resolves.toBe(false);
      expect(onError).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event('online'));
      await vi.runAllTimersAsync();
      expect(client.isAuthenticated()).toBe(true);
      expect(transport.requestsTo('/authenticate')).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(transport.requestsTo('/authenticate')).toHaveLength(2);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after three timed retries and does not retry a 4xx', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      transport.fallback = { ok: false, status: 503, body: {} };
      const client = new GrovsClient(
        { apiKey: 'k' },
        { transport, storage: new FakeStorage(), autoStartEvents: false },
      );
      await client.configure();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(transport.requestsTo('/authenticate')).toHaveLength(4);
      client.dispose();

      const denied = new FakeTransport();
      denied.fallback = { ok: false, status: 403, body: {} };
      const second = new GrovsClient(
        { apiKey: 'k' },
        { transport: denied, storage: new FakeStorage(), autoStartEvents: false },
      );
      await second.configure();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(denied.requestsTo('/authenticate')).toHaveLength(1);
      second.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cross-tab reset, round 4', () => {
  const removal = () =>
    new StorageEvent('storage', { key: 'linksquared', oldValue: 'v1', newValue: null });

  it('is honoured after a disable and re-enable', async () => {
    localStorage.clear();
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient({ apiKey: 'k' }, { transport });
    await client.configure();
    client.setEnabled(false);
    client.setEnabled(true);
    window.dispatchEvent(removal());
    expect(client.isAuthenticated()).toBe(false);
    client.dispose();
  });

  it('a late event, after another tab authenticated again, clears memory but not the device', async () => {
    localStorage.clear();
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient({ apiKey: 'k' }, { transport });
    await client.configure();
    // The other tab has already reset and authenticated as a new visitor.
    localStorage.setItem('linksquared', 'v2');
    localStorage.setItem(scopedKey('grovs_opens', 'k'), '1');
    window.dispatchEvent(removal());
    expect(client.isAuthenticated()).toBe(false);
    expect(localStorage.getItem('linksquared')).toBe('v2');
    expect(localStorage.getItem(scopedKey('grovs_opens', 'k'))).toBe('1');
    client.dispose();
    localStorage.clear();
  });

  it('closes the message list', async () => {
    localStorage.clear();
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient({ apiKey: 'k' }, { transport });
    await client.configure();
    const close = vi.fn();
    client.messagesUI = () => ({ displayAutomaticMessages: () => Promise.resolve(), close });
    window.dispatchEvent(removal());
    expect(close).toHaveBeenCalled();
    client.dispose();
  });
});

describe('dispose() invalidates queued work', () => {
  it('a queued identity update does not send after disposal', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();
    let release!: (r: { ok: boolean; status: number; body: unknown }) => void;
    transport.hold = new Promise((resolve) => {
      release = resolve;
    });
    client.setUserIdentifier('first');
    // The push is chained on a microtask; let it leave before queueing more.
    await Promise.resolve();
    await Promise.resolve();
    client.setUserIdentifier('second');
    client.dispose();
    release({ ok: true, status: 200, body: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.requestsTo('/visitor_attributes')).toHaveLength(1);
  });
});

describe('reset() cleans the device even when writes are refused', () => {
  it('removes the identifier and queue while consent is pending and setItem throws', () => {
    localStorage.clear();
    localStorage.setItem('linksquared', 'old');
    localStorage.setItem(scopedKey('grovs_events', 'k'), '[{"id":"x"}]');
    document.cookie = 'linksquared=old;path=/';
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      const client = new GrovsClient(
        { apiKey: 'k', requireConsent: true },
        { transport: new FakeTransport(), autoStartEvents: false },
      );
      client.reset();
      client.dispose();
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(localStorage.getItem('linksquared')).toBeNull();
    expect(localStorage.getItem(scopedKey('grovs_events', 'k'))).toBeNull();
    expect(document.cookie).not.toContain('old');
  });
});

describe('input bounds', () => {
  it('stops walking a wide container once the budget is spent', () => {
    const wide = Array.from({ length: 200_000 }, (_, i) => i);
    const started = performance.now();
    expect(sanitizeProperties({ wide })).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('an oversized event name is truncated rather than costing the backlog', () => {
    const storage = new FakeStorage();
    const transport = new FakeTransport();
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage, autoStartEvents: false },
    );
    client.track('healthy');
    client.track('x'.repeat(1_000_001));
    client.shutdown();
    const stored = JSON.parse(storage.get(QUEUE_STORAGE_KEY) ?? '[]') as QueuedEvent[];
    expect(stored.map((e) => e.eventName?.length)).toEqual([7, 255]);
  });

  it('track() warns instead of throwing on wrong argument types', () => {
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport: new FakeTransport(), storage: new FakeStorage(), autoStartEvents: false },
    );
    expect(() => client.track('x', 'abc' as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => client.track('x', {}, 'tag' as unknown as string[])).not.toThrow();
    expect(() => client.track(42 as unknown as string)).not.toThrow();
  });
});

describe('round 5', () => {
  const removal = () =>
    new StorageEvent('storage', { key: 'linksquared', oldValue: 'v1', newValue: null });

  it('a tab waiting on an auth retry honours another tab\'s reset', async () => {
    vi.useFakeTimers();
    try {
      localStorage.clear();
      localStorage.setItem('linksquared', 'v1');
      const transport = new FakeTransport();
      transport.enqueueStatus(503).enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
      const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
      await client.configure();
      // The other tab's reset: key gone, then the event every sibling receives.
      localStorage.removeItem('linksquared');
      window.dispatchEvent(removal());
      await vi.advanceTimersByTimeAsync(31_000);
      // No retry after the reset, and had one run it would carry no id.
      expect(transport.requestsTo('/authenticate')).toHaveLength(1);
      expect(localStorage.getItem('linksquared')).toBeNull();
      client.dispose();
    } finally {
      vi.useRealTimers();
      localStorage.clear();
    }
  });

  it('a late reset does not write the old queue into the new visitor\'s store', async () => {
    localStorage.clear();
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();
    client.track('old_visitor_event');
    // The other tab reset, re-authenticated and wrote a fresh, empty store.
    localStorage.setItem('linksquared', 'v2');
    localStorage.removeItem(scopedKey('grovs_events', 'k'));
    window.dispatchEvent(removal());
    expect(localStorage.getItem(scopedKey('grovs_events', 'k')) ?? '').not.toContain('old_visitor_event');
    client.dispose();
    localStorage.clear();
  });

  it('time_spent logged at hide does not start an ordinary drain', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();
    client.eventsHandler.onPathResolved(null);
    for (let i = 0; i < 49; i += 1) client.track(`e${i}`);
    client.eventsHandler.log('time_spent', 3);
    await Promise.resolve();
    expect(transport.requestsTo('/events/batch')).toHaveLength(0);
    client.dispose();
  });

  it('a string custom redirect and a null argument do not reject generateLink', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage: new FakeStorage(), autoStartEvents: false },
    );
    await client.configure();
    const { LinkGenerator } = await import('../../src/links/links');
    const links = new LinkGenerator(client);
    transport.fallback = { ok: true, status: 200, body: { link: 'https://l' } };
    await expect(links.generateLink(null)).resolves.toBe('https://l');
    await expect(
      links.generateLink({ customRedirects: { ios: 'x' as unknown as { link: string } } }),
    ).resolves.toBe('https://l');
    client.dispose();
  });

  it('bounds alias matching on a long path', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/docs/*/*/*.html': 'Docs' });
    const started = performance.now();
    expect(aliases.resolve('/docs/' + 'a/'.repeat(800) + 'x')).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('an event is immutable once it could have been sent', () => {
  function handlerOver(storage: FakeStorage) {
    const transport = new FakeTransport();
    const client = new GrovsClient(
      { apiKey: 'k' },
      { transport, storage, autoStartEvents: false },
    );
    return { client, transport };
  }

  // The backend's event_id is a content hash folding in the resolved link, so
  // a replay that gained a path is a different event there and counts twice.
  it('does not stamp a later campaign onto an event a previous page load could have sent', () => {
    const storage = new FakeStorage();

    // Page one: a direct visit. The payload resolves with no campaign.
    const first = handlerOver(storage);
    first.client.track('checkout');
    first.client.eventsHandler.onPathResolved(null);
    first.client.shutdown();
    const afterFirst = JSON.parse(storage.get(QUEUE_STORAGE_KEY) ?? '[]') as QueuedEvent[];
    expect(afterFirst[0]?.path).toBeUndefined();

    // Page two, same session, opened from a campaign link.
    const second = handlerOver(storage);
    second.client.eventsHandler.onPathResolved('campaign-b');
    second.client.shutdown();

    const afterSecond = JSON.parse(storage.get(QUEUE_STORAGE_KEY) ?? '[]') as QueuedEvent[];
    const checkout = afterSecond.find((event) => event.eventName === 'checkout');
    expect(checkout?.path).toBeUndefined();
  });

  it('still back-fills an event whose attribution was never settled', () => {
    const storage = new FakeStorage();
    // A consent-pending client queued this and never resolved a path.
    const first = handlerOver(storage);
    first.client.track('before_consent');
    first.client.shutdown();
    expect(
      (JSON.parse(storage.get(QUEUE_STORAGE_KEY) ?? '[]') as QueuedEvent[])[0]?.pathFinal,
    ).toBeUndefined();

    const second = handlerOver(storage);
    second.client.eventsHandler.onPathResolved('campaign-b');
    second.client.shutdown();

    const stored = JSON.parse(storage.get(QUEUE_STORAGE_KEY) ?? '[]') as QueuedEvent[];
    expect(stored[0]?.path).toBe('campaign-b');
  });

  it('sends a byte-identical body on a replay, and never sends the flag', async () => {
    const storage = new FakeStorage();
    const first = handlerOver(storage);
    first.transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    await first.client.configure();
    first.client.track('checkout');
    first.transport.fallback = { ok: false, status: 503, body: {} };
    await first.client.flush();
    const firstBody = first.transport.requestsTo('/events/batch').pop()?.body;
    first.client.shutdown();

    const second = handlerOver(storage);
    second.transport.enqueue(AUTH_OK).enqueue(PAYLOAD_NONE);
    await second.client.configure();
    await second.client.flush();
    const replayBody = second.transport.requestsTo('/events/batch').pop()?.body;

    expect(replayBody).toEqual(firstBody);
    expect(JSON.stringify(replayBody)).not.toContain('pathFinal');
    second.client.dispose();
  });
});

describe('alias wildcard cost is bounded', () => {
  it('ignores a pattern with more wildcards than the limit, and says why', () => {
    const aliases = new ScreenAliases();
    const logger = new Logger();
    const warn = vi.fn();
    logger.setLevel('warn');
    vi.spyOn(console, 'warn').mockImplementation(warn);
    aliases.set({ '/docs/*/*/*/*/*.html': 'Docs', '/docs/*': 'Docs root' }, logger);
    expect(aliases.resolve('/docs/a/b/c/d/e.html')).toBe('Docs root');
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('matches a worst-case non-matching path well inside a frame', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/docs/*/*.html': 'Docs' });
    const path = '/docs/' + 'a/'.repeat(255) + 'wrong';
    const started = performance.now();
    expect(aliases.resolve(path)).toBeNull();
    expect(performance.now() - started).toBeLessThan(16);
  });
});
