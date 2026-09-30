import { describe, expect, it } from 'vitest';
import { readCampaign } from '../../src/inapp/definition';
import { Engine, type EngineState } from '../../src/inapp/engine';
import type { EngineEvent } from '../../src/inapp/types';
import { deviceOf, merge, readJson } from './shared';

type Json = Record<string, unknown>;

const FILE = readJson('cases.json');
const BASE = FILE.base_campaign as Json;
const AT = Date.parse('2026-10-01T10:00:00Z');
const CART: EngineEvent = { type: 'event', name: 'cart_viewed' };
const OPTIONS = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, text: `Option ${id}` }));

function question(changes: Json = {}): Json {
  return { id: 'q1', type: 'stars', options: [], comment: null, thanks: null, review_from: null, ...changes };
}

function read(content: Json) {
  return readCampaign(merge(BASE, { content }));
}

describe('a question in a definition', () => {
  it('reads each kind', () => {
    expect(read({ question: question() })?.content.question).toEqual({
      id: 'q1',
      type: 'stars',
      options: [],
      comment: null,
      thanks: null,
    });
    const comment = { split: 3, low: 'What went wrong?', high: 'What did you like?' };
    const stars = read({ question: question({ comment, thanks: 'Thank you' }) });
    expect(stars?.content.question).toMatchObject({ type: 'stars', comment, thanks: 'Thank you' });
    for (const count of [2, 5]) {
      const choice = read({ question: question({ type: 'choice', options: OPTIONS.slice(0, count) }) });
      expect(choice?.content.question?.options).toEqual(OPTIONS.slice(0, count));
    }
  });

  it('is optional', () => {
    expect(read({})?.content.question).toBeNull();
    expect(read({ question: null })?.content.question).toBeNull();
  });

  it('ignores fields it does not know', () => {
    const options = OPTIONS.slice(0, 2).map((option) => ({ ...option, later: 1 }));
    const read1 = read({ question: question({ type: 'choice', options, later: true, review_from: 4 }) });
    expect(read1?.content.question?.options).toEqual(OPTIONS.slice(0, 2));
  });

  it('counts as something to tap in a message that cannot be dismissed', () => {
    expect(read({ dismissible: false, question: question() })).not.toBeNull();
    expect(read({ dismissible: false })).toBeNull();
  });

  it('is unsupported on an alert or a picture-only template, which draw no question', () => {
    for (const template of ['alert', 'cover_image', 'interstitial_image', 'half_interstitial_image']) {
      expect(readCampaign(merge(BASE, { template, content: { question: question(), dismissible: false } })), template).toBeNull();
      expect(readCampaign(merge(BASE, { template, content: { question: question() } })), template).toBeNull();
      expect(readCampaign(merge(BASE, { template })), template).not.toBeNull();
    }
    for (const template of ['cover', 'interstitial', 'half_interstitial', 'header', 'footer']) {
      expect(readCampaign(merge(BASE, { template, content: { question: question() } })), template).not.toBeNull();
    }
  });

  it('is unsupported when its type is nps, a kind this SDK does not know', () => {
    expect(read({ question: question({ type: 'nps' }) })).toBeNull();
  });

  it('is unsupported when malformed', () => {
    const button = { id: 'b1', text: 'Go', action: { type: 'close' } };
    const malformed: Json[] = [
      { question: question({ type: 'slider' }) },
      { question: question({ type: 'choice' }) },
      { question: question({ type: 'choice', options: OPTIONS.slice(0, 1) }) },
      { question: question({ type: 'choice', options: OPTIONS }) },
      { question: question({ type: 'choice', options: [OPTIONS[0], { id: 'b' }] }) },
      { question: question({ type: 'stars', options: OPTIONS.slice(0, 2) }) },
      { question: question(), buttons: [button] },
      { question: question(), tap_action: { type: 'close' } },
      { question: question({ id: '' }) },
      { question: question({ comment: 'text' }) },
      { question: question({ comment: { split: '3', low: 'Why?', high: null } }) },
      { question: question({ comment: { split: 3, low: 5, high: null } }) },
      { question: question({ thanks: 5 }) },
      { question: 'stars' },
      { question: [] },
    ];
    for (const content of malformed) expect(read(content), JSON.stringify(content)).toBeNull();
  });
});

describe('an answer in the engine', () => {
  const campaigns = [merge(BASE, { content: { question: question() } })];

  function build(state?: EngineState): Engine {
    let next = 0;
    return new Engine({
      device: deviceOf(FILE.base_device as Json),
      campaigns,
      globalCaps: { session: null, day: null },
      syncedAt: AT,
      newViewId: () => `d${(next += 1)}`,
      ...(state ? { state } : {}),
    });
  }

  it('outlasts a session, a sync and a reload from what was stored', () => {
    const engine = build();
    expect(engine.track(CART, AT).show).toBe('c1');
    engine.answer('c1');
    engine.answer('c1');
    expect(engine.state().answered).toEqual(['c1']);

    engine.startSession();
    engine.markSynced(AT + 1000);
    expect(engine.track(CART, AT + 2000)).toMatchObject({ show: null, reasons: { c1: 'answered' } });

    const stored = JSON.parse(JSON.stringify(engine.state())) as EngineState;
    expect(build(stored).track(CART, AT + 3000)).toMatchObject({ show: null, reasons: { c1: 'answered' } });
  });

  it('loads state stored before questions existed', () => {
    const engine = build({ views: [], session: [], counts: {}, syncedAt: AT });
    expect(engine.state().answered).toEqual([]);
    expect(engine.track(CART, AT).show).toBe('c1');
  });
});
