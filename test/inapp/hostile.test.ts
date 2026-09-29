import { describe, expect, it } from 'vitest';
import { readCampaign } from '../../src/inapp/definition';
import type { EngineEvent } from '../../src/inapp/types';
import { build, loadCases } from './shared';

/**
 * A definition is data from the network. Whatever arrives, the engine must
 * answer, never throw: one bad campaign cannot be allowed to stop the others
 * or the host page.
 */

const VALUES: unknown[] = [null, 'text', '', 5, -1, 1.5, true, [], [1], ['x'], [null], {}, { a: 1 }];
const EVENTS: EngineEvent[] = [
  { type: 'app_open' },
  { type: 'screen_view', name: 'Cart' },
  { type: 'event', name: 'cart_viewed', properties: { v: 1 } },
];
const AT = Date.parse('2026-10-01T10:00:00Z');

type Path = (string | number)[];

function paths(node: unknown, trail: Path = []): Path[] {
  const inner: Path[] = [];
  if (Array.isArray(node)) node.forEach((child, index) => inner.push(...paths(child, [...trail, index])));
  else if (typeof node === 'object' && node !== null) {
    for (const key of Object.keys(node)) inner.push(...paths((node as Record<string, unknown>)[key], [...trail, key]));
  }
  return trail.length === 0 ? inner : [trail, ...inner];
}

function replaced(node: unknown, trail: Path, value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(node)) as unknown;
  let inner = copy as Record<string | number, unknown>;
  for (const key of trail.slice(0, -1)) inner = inner[key] as Record<string | number, unknown>;
  const last = trail[trail.length - 1];
  if (last !== undefined) inner[last] = value;
  return copy;
}

describe('hostile definitions', () => {
  const cases = loadCases();
  const readable = cases.flatMap((kase) => kase.campaigns).filter((campaign) => readCampaign(campaign) !== null);

  it('has readable campaigns to mutate', () => {
    expect(readable.length).toBeGreaterThan(40);
  });

  it('reads or refuses every mutation without throwing', () => {
    let tried = 0;
    for (const campaign of readable.slice(0, 40)) {
      for (const trail of paths(campaign)) {
        for (const value of VALUES) {
          expect(() => readCampaign(replaced(campaign, trail, value))).not.toThrow();
          tried += 1;
        }
      }
    }
    expect(tried).toBeGreaterThan(10_000);
  });

  it('refuses a definition that is not an object', () => {
    for (const value of VALUES.filter((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
      expect(readCampaign(value)).toBeNull();
    }
  });

  it('answers every event whatever one campaign holds', () => {
    const kase = cases.find((k) => k.name === 'personalization fills user and event fields and uses fallbacks');
    const campaign = kase?.campaigns[0];
    if (!kase || !campaign) throw new Error('case not found');
    for (const trail of paths(campaign)) {
      for (const value of VALUES) {
        const engine = build(kase, [replaced(campaign, trail, value), null, 5, 'text', []]);
        for (const event of EVENTS) expect(typeof engine.track(event, AT).reasons).toBe('object');
      }
    }
  });

  it('answers events whose properties are hostile', () => {
    const kase = cases[0];
    if (!kase) throw new Error('no cases');
    const engine = build(kase);
    for (const value of VALUES) {
      const event = { type: 'event', name: 'cart_viewed', properties: { v: value, __proto__: value } } as EngineEvent;
      expect(() => engine.track(event, AT)).not.toThrow();
    }
  });
});
