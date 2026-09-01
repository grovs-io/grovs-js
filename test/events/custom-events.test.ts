import { describe, expect, it, vi } from 'vitest';
import { CustomEventsHandler } from '../../src/events/custom-events-handler';
import { sanitizeProperties } from '../../src/events/sanitize';
import { EventsHandler } from '../../src/events/events-handler';
import { PersistedQueue } from '../../src/storage/persisted-queue';
import { SessionManager } from '../../src/core/session';
import { ApiService } from '../../src/net/api';
import { resolveConfig } from '../../src/core/config';
import { Context } from '../../src/core/context';
import { Logger } from '../../src/logging/logger';
import { FakeTransport } from '../helpers/fake-transport';
import { FakeStorage } from '../helpers/fake-storage';
import { FakeClock } from '../helpers/fake-clock';

function harness() {
  const transport = new FakeTransport();
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const logger = new Logger();
  const queue = new PersistedQueue(storage, clock);
  const session = new SessionManager(storage, clock);
  const events = new EventsHandler({
    api: new ApiService(resolveConfig({ apiKey: 'k' }), new Context(), transport, () => 'https://x'),
    queue,
    session,
    clock,
    logger,
    currentPath: () => null,
    isEnabled: () => true,
  });
  const custom = new CustomEventsHandler({ events, session, clock, logger, currentPath: () => null });
  return { custom, queue, clock, logger, events };
}

describe('sanitizeProperties', () => {
  it('passes strings, numbers, booleans and null through', () => {
    expect(sanitizeProperties({ a: 'x', b: 1, c: true, d: null })).toEqual({
      a: 'x',
      b: 1,
      c: true,
      d: null,
    });
  });

  it('coerces Date and URL to strings', () => {
    const result = sanitizeProperties({
      when: new Date('2026-01-01T00:00:00Z'),
      where: new URL('https://example.com/x'),
    });
    expect(result?.['when']).toBe('2026-01-01T00:00:00.000Z');
    expect(result?.['where']).toBe('https://example.com/x');
  });

  // Per-key dropping: one bad value must not discard the whole event's data.
  it('drops NaN and Infinity per key, keeping the rest', () => {
    const result = sanitizeProperties({ good: 1, nan: NaN, inf: Infinity });
    expect(result).toEqual({ good: 1 });
  });

  it('drops functions, symbols and undefined per key', () => {
    const result = sanitizeProperties({
      keep: 'yes',
      fn: () => undefined,
      sym: Symbol('x'),
      undef: undefined,
    });
    expect(result).toEqual({ keep: 'yes' });
  });

  it('sanitizes nested objects and arrays recursively', () => {
    const result = sanitizeProperties({
      nested: { ok: 1, bad: NaN, deeper: { when: new Date('2026-01-01T00:00:00Z') } },
      list: [1, NaN, 'x'],
    });
    expect(result).toEqual({
      nested: { ok: 1, deeper: { when: '2026-01-01T00:00:00.000Z' } },
      list: [1, 'x'],
    });
  });

  // A circular reference would make JSON.stringify throw and take the whole
  // event with it.
  it('drops circular references rather than throwing', () => {
    const circular: Record<string, unknown> = { name: 'root' };
    circular['self'] = circular;

    expect(() => sanitizeProperties(circular)).not.toThrow();
    const result = sanitizeProperties(circular);
    expect(result).toEqual({ name: 'root' });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('drops a key whose getter throws, keeping the rest', () => {
    const properties = {
      good: 1,
      get boom(): string {
        throw new Error('kaboom');
      },
      alsoGood: 'x',
    };

    expect(() => sanitizeProperties(properties)).not.toThrow();
    expect(sanitizeProperties(properties)).toEqual({ good: 1, alsoGood: 'x' });
  });

  it('drops a nested key whose getter throws without losing its siblings', () => {
    const nested = {
      outer: {
        kept: true,
        get boom(): string {
          throw new Error('kaboom');
        },
      },
      list: [
        1,
        {
          get boom(): string {
            throw new Error('kaboom');
          },
        },
      ],
    };

    expect(sanitizeProperties(nested)).toEqual({ outer: { kept: true }, list: [1, {}] });
  });

  it('names the dropped key in the warning', () => {
    const logger = new Logger();
    logger.setLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    sanitizeProperties(
      {
        get boom(): string {
          throw new Error('kaboom');
        },
        fine: 1,
      },
      logger,
    );

    expect(String(spy.mock.calls[0]?.[0])).toContain('boom');
    vi.restoreAllMocks();
  });

  it('does not strand the cycle set when listing a key throws', () => {
    let firstCall = true;
    const flaky = new Proxy(
      { id: 1 },
      {
        ownKeys(target) {
          if (firstCall) {
            firstCall = false;
            throw new Error('kaboom');
          }
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(sanitizeProperties({ a: flaky, b: flaky })).toEqual({ b: { id: 1 } });
  });

  it('keeps a value referenced by two sibling keys', () => {
    const shared = { id: 1 };
    expect(sanitizeProperties({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });

  it('drops everything past 8 KB but lets the event through', () => {
    const logger = new Logger();
    logger.setLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(sanitizeProperties({ blob: 'x'.repeat(9000) }, logger)).toBeUndefined();
    expect(String(spy.mock.calls[0]?.[0])).toContain('8192');
    vi.restoreAllMocks();
  });

  it('returns undefined for empty or absent properties', () => {
    expect(sanitizeProperties(undefined)).toBeUndefined();
    expect(sanitizeProperties({})).toBeUndefined();
  });

  it('stringifies bigint, which JSON cannot encode', () => {
    expect(sanitizeProperties({ big: 10n })).toEqual({ big: '10' });
  });
});

describe('CustomEventsHandler.track', () => {
  it('queues a custom event with properties', () => {
    const { custom, queue } = harness();
    custom.track('purchase', { sku: 'x-1', price: 19.99 });

    const event = queue.all()[0];
    expect(event?.eventName).toBe('purchase');
    expect(event?.properties).toEqual({ sku: 'x-1', price: 19.99 });
  });

  it('rejects an empty name', () => {
    const { custom, queue } = harness();
    custom.track('   ');
    expect(queue.size()).toBe(0);
  });

  // The backend answers 400 for these; failing here names the reason.
  it('rejects reserved system event names', () => {
    const { custom, queue } = harness();
    for (const name of ['install', 'app_open', 'time_spent', 'user_referred']) {
      custom.track(name);
    }
    expect(queue.size()).toBe(0);
  });

  it('directs screen_view to trackScreenView', () => {
    const { custom, queue, logger } = harness();
    logger.setLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    custom.track('screen_view');

    expect(queue.size()).toBe(0);
    expect(String(spy.mock.calls[0]?.[0])).toContain('trackScreenView');
    vi.restoreAllMocks();
  });

  it('stamps session id and a stable event id', () => {
    const { custom, queue } = harness();
    custom.track('x');
    expect(queue.all()[0]?.sessionId).toBeTruthy();
    expect(queue.all()[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('CustomEventsHandler.trackScreenView', () => {
  it('injects screen_name into properties', () => {
    const { custom, queue } = harness();
    custom.trackScreenView('Checkout', { section: 'payment' });
    expect(queue.all()[0]?.properties).toEqual({ section: 'payment', screen_name: 'Checkout' });
  });

  it('deduplicates the same screen within one second', () => {
    const { custom, queue } = harness();
    custom.trackScreenView('Home');
    custom.trackScreenView('Home');
    custom.trackScreenView('Home');
    expect(queue.size()).toBe(1);
  });

  it('allows the same screen again after a second', () => {
    const { custom, queue, clock } = harness();
    custom.trackScreenView('Home');
    clock.advance(1001);
    custom.trackScreenView('Home');
    expect(queue.size()).toBe(2);
  });

  it('does not deduplicate different screens', () => {
    const { custom, queue } = harness();
    custom.trackScreenView('Home');
    custom.trackScreenView('Checkout');
    expect(queue.size()).toBe(2);
  });

  // The same screen in a new session is a genuinely new view.
  it('resets dedup on session rotation', () => {
    const { custom, queue, clock } = harness();
    custom.trackScreenView('Home');
    clock.advanceMinutes(45);
    custom.trackScreenView('Home');
    expect(queue.size()).toBe(2);
  });

  // Matches iOS: custom events carry the most recently viewed screen.
  it('stamps the current screen onto later custom events', () => {
    const { custom, queue } = harness();
    custom.trackScreenView('Checkout');
    custom.track('purchase', { sku: 'x' });

    const purchase = queue.all().find((e) => e.eventName === 'purchase');
    expect(purchase?.properties).toEqual({ sku: 'x', screen_name: 'Checkout' });
  });
});

describe('CustomEventsHandler global tags', () => {
  it('attaches global tags to every event', () => {
    const { custom, queue } = harness();
    custom.setGlobalTags(['beta']);
    custom.track('x');
    expect(queue.all()[0]?.tags).toEqual(['beta']);
  });

  it('merges per-event tags ahead of global ones', () => {
    const { custom, queue } = harness();
    custom.setGlobalTags(['global']);
    custom.track('x', undefined, ['specific']);
    expect(queue.all()[0]?.tags).toEqual(['specific', 'global']);
  });

  // Per-event tags describe this event; global tags describe everything. When
  // only some fit, the specific ones are the informative half.
  it('keeps per-event tags when the combined count exceeds 20', () => {
    const { custom, queue } = harness();
    custom.setGlobalTags(Array.from({ length: 20 }, (_, i) => `g${i}`));
    custom.track('x', undefined, ['specific']);

    const tags = queue.all()[0]?.tags ?? [];
    expect(tags).toHaveLength(20);
    expect(tags[0]).toBe('specific');
  });

  it('does not duplicate a tag present in both', () => {
    const { custom, queue } = harness();
    custom.setGlobalTags(['shared']);
    custom.track('x', undefined, ['shared']);
    expect(queue.all()[0]?.tags).toEqual(['shared']);
  });

  it('clears global tags with null', () => {
    const { custom, queue } = harness();
    custom.setGlobalTags(['beta']);
    custom.setGlobalTags(null);
    custom.track('x');
    expect(queue.all()[0]?.tags).toBeUndefined();
  });
});
