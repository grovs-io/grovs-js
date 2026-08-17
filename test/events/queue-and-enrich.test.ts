import { describe, expect, it, vi } from 'vitest';
import { PersistedQueue, QUEUE_STORAGE_KEY } from '../../src/storage/persisted-queue';
import { enrich } from '../../src/events/enrich';
import type { QueuedEvent } from '../../src/events/event';
import { ENRICHMENT_KEYS } from '../../src/contract/event-contract';
import { FakeStorage } from '../helpers/fake-storage';
import { FakeClock } from '../helpers/fake-clock';

function event(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    id: overrides.id ?? 'id-1',
    event: 'app_open',
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('enrich', () => {
  it('emits every enrichment key the contract requires', () => {
    const body = enrich(
      event({ path: 'abc', engagementTime: 12, tags: ['a'] }),
    ) as unknown as Record<string, unknown>;

    for (const key of ENRICHMENT_KEYS) {
      expect(body).toHaveProperty(key);
    }
  });

  it('sends path, never link', () => {
    const body = enrich(event({ path: 'abc' })) as unknown as Record<string, unknown>;
    expect(body['path']).toBe('abc');
    expect(body).not.toHaveProperty('link');
  });

  it('preserves event_id verbatim', () => {
    const body = enrich(event({ id: 'stable-id' })) as unknown as Record<string, unknown>;
    expect(body['event_id']).toBe('stable-id');
  });

  it('formats created_at as ISO 8601', () => {
    const body = enrich(event({ createdAt: 1_700_000_000_000 })) as unknown as Record<string, unknown>;
    expect(body['created_at']).toBe('2023-11-14T22:13:20.000Z');
  });

  it('emits event for system events and event_name for custom ones', () => {
    const system = enrich(event()) as unknown as Record<string, unknown>;
    expect(system['event']).toBe('app_open');
    expect(system).not.toHaveProperty('event_name');

    const custom = enrich({
      id: 'i',
      eventName: 'purchase',
      createdAt: 1,
      sessionId: 's',
      properties: { sku: 'x' },
    }) as unknown as Record<string, unknown>;
    expect(custom['event_name']).toBe('purchase');
    expect(custom['properties']).toEqual({ sku: 'x' });
    expect(custom).not.toHaveProperty('event');
  });

  it('caps tags at 20', () => {
    const tags = Array.from({ length: 25 }, (_, i) => `tag-${i}`);
    const body = enrich(event({ tags })) as unknown as Record<string, unknown>;
    expect((body['tags'] as string[]).length).toBe(20);
  });

  it('truncates event_name and tags to 255 characters', () => {
    const long = 'x'.repeat(300);
    const body = enrich({
      id: 'i',
      eventName: long,
      createdAt: 1,
      sessionId: 's',
      tags: [long],
    }) as unknown as Record<string, unknown>;

    expect((body['event_name'] as string).length).toBe(255);
    expect((body['tags'] as string[])[0]?.length).toBe(255);
  });

  it('omits optional keys that have no value', () => {
    const body = enrich(event()) as unknown as Record<string, unknown>;
    expect(body).not.toHaveProperty('path');
    expect(body).not.toHaveProperty('engagement_time');
    expect(body).not.toHaveProperty('tags');
  });

  it('keeps an engagement time of zero, which is a real measurement', () => {
    const body = enrich(event({ engagementTime: 0 })) as unknown as Record<string, unknown>;
    expect(body['engagement_time']).toBe(0);
  });
});

describe('PersistedQueue', () => {
  function make(storage = new FakeStorage(), clock = new FakeClock()) {
    const dropped: { count: number; reason: string }[] = [];
    const queue = new PersistedQueue(storage, clock, (count, reason) =>
      dropped.push({ count, reason }),
    );
    return { queue, storage, clock, dropped };
  }

  it('holds added events in memory immediately', () => {
    const { queue } = make();
    queue.add(event({ id: 'a' }));
    expect(queue.size()).toBe(1);
  });

  it('removes by id, which survives a JSON round trip', () => {
    const { queue } = make();
    queue.add(event({ id: 'a' }));
    queue.add(event({ id: 'b' }));
    queue.remove(['a']);
    expect(queue.all().map((e) => e.id)).toEqual(['b']);
  });

  // A4: the 1,001st event evicts the oldest, not the newest.
  it('evicts oldest-first past the 1000 event cap', () => {
    const { queue, dropped } = make();
    for (let i = 0; i < 1001; i += 1) queue.add(event({ id: `id-${i}` }));

    expect(queue.size()).toBe(1000);
    expect(queue.all()[0]?.id).toBe('id-1');
    expect(queue.all()[999]?.id).toBe('id-1000');
    expect(dropped[0]?.count).toBe(1);
  });

  // A4: an 8-day-old event is discarded, not sent.
  it('discards events older than seven days', () => {
    const clock = new FakeClock();
    const { queue, dropped } = make(new FakeStorage(), clock);
    queue.add(event({ id: 'stale', createdAt: clock.now() }));
    queue.add(event({ id: 'fresh', createdAt: clock.now() }));

    clock.advanceDays(8);
    queue.add(event({ id: 'newest', createdAt: clock.now() }));

    const survivors = queue.pruneStale();
    expect(survivors.map((e) => e.id)).toEqual(['newest']);
    expect(dropped[0]?.count).toBe(2);
  });

  it('keeps an event at six days', () => {
    const clock = new FakeClock();
    const { queue } = make(new FakeStorage(), clock);
    queue.add(event({ createdAt: clock.now() }));
    clock.advanceDays(6);
    expect(queue.pruneStale()).toHaveLength(1);
  });

  // T13: 100 rapid enqueues produce one write, not 100.
  it('debounces persistence', () => {
    vi.useFakeTimers();
    const storage = new FakeStorage();
    const setSpy = vi.spyOn(storage, 'set');
    const { queue } = make(storage);

    for (let i = 0; i < 100; i += 1) queue.add(event({ id: `id-${i}` }));
    expect(setSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(setSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('forces a synchronous write on flushToStorage regardless of the timer', () => {
    vi.useFakeTimers();
    const storage = new FakeStorage();
    const { queue } = make(storage);

    queue.add(event({ id: 'a' }));
    expect(storage.get(QUEUE_STORAGE_KEY)).toBeNull();

    queue.flushToStorage();
    expect(storage.get(QUEUE_STORAGE_KEY)).toContain('"a"');
    vi.useRealTimers();
  });

  it('reloads persisted events on construction', () => {
    const storage = new FakeStorage();
    const { queue } = make(storage);
    queue.add(event({ id: 'persisted' }));
    queue.flushToStorage();

    const reloaded = new PersistedQueue(storage, new FakeClock());
    expect(reloaded.all().map((e) => e.id)).toEqual(['persisted']);
  });

  // A4: event_id is identical across a reload.
  it('preserves event_id across a storage round trip', () => {
    const storage = new FakeStorage();
    const { queue } = make(storage);
    queue.add(event({ id: 'must-not-change' }));
    queue.flushToStorage();

    const reloaded = new PersistedQueue(storage, new FakeClock());
    expect(reloaded.all()[0]?.id).toBe('must-not-change');
  });

  it('ignores corrupt stored data rather than throwing', () => {
    const storage = new FakeStorage();
    storage.set(QUEUE_STORAGE_KEY, 'not json{{{');
    expect(new PersistedQueue(storage, new FakeClock()).all()).toEqual([]);
  });

  it('drops stored entries missing an id, which could never be acked', () => {
    const storage = new FakeStorage();
    storage.set(
      QUEUE_STORAGE_KEY,
      JSON.stringify([
        { createdAt: 1, event: 'view' },
        { id: 'ok', createdAt: 2, event: 'view' },
      ]),
    );
    expect(new PersistedQueue(storage, new FakeClock()).all().map((e) => e.id)).toEqual(['ok']);
  });

  /**
   * A record with neither name reaches enrich(), which throws — inside a
   * `void flush()`, so it surfaced as an unhandled rejection and every valid
   * event behind it stayed blocked on that flush and every future one. Total
   * and silent blast radius from one malformed record.
   */
  it('drops a stored entry carrying neither event nor event_name', () => {
    const storage = new FakeStorage();
    storage.set(
      QUEUE_STORAGE_KEY,
      JSON.stringify([
        { id: 'poison', createdAt: 1, sessionId: 's' },
        { id: 'good', createdAt: 2, event: 'view', sessionId: 's' },
      ]),
    );

    const queue = new PersistedQueue(storage, new FakeClock());
    expect(queue.all().map((e) => e.id)).toEqual(['good']);
  });

  it('back-fills a resolved path through transform', () => {
    const { queue } = make();
    queue.add(event({ id: 'a' }));
    queue.add(event({ id: 'b', path: 'existing' }));

    queue.transform((e) => (e.path ? e : { ...e, path: 'resolved' }));

    expect(queue.all().map((e) => e.path)).toEqual(['resolved', 'existing']);
  });

  it('empties on clear', () => {
    const storage = new FakeStorage();
    const { queue } = make(storage);
    queue.add(event({ id: 'a' }));
    queue.clear();
    expect(queue.size()).toBe(0);
    expect(storage.get(QUEUE_STORAGE_KEY)).toBe('[]');
  });
});
