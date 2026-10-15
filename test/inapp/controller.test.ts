import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../../src/logging/logger';
import {
  InAppController,
  type Answered,
  type Commented,
  type ControllerDeps,
  type Outcome,
  type Presentation,
  type SyncResult,
} from '../../src/inapp/controller';
import { IN_APP_KEY, IN_APP_STATE_KEY, emptySynced, saveSynced } from '../../src/inapp/store';
import type { EngineEvent } from '../../src/inapp/types';
import { FakeClock } from '../helpers/fake-clock';
import { FakeStorage } from '../helpers/fake-storage';
import { merge, readJson } from './shared';

type Json = Record<string, unknown>;

const BASE = readJson('cases.json').base_campaign as Json;
const START = Date.parse('2026-10-01T10:00:00Z');
const CART: EngineEvent = { type: 'event', name: 'cart_viewed' };

function campaign(changes: Json = {}): Json {
  return merge(BASE, changes);
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

class FakePresenter {
  readonly shown: Presentation[] = [];
  private settle: ((outcome: Outcome) => void) | null = null;
  fail = false;
  gone = false;
  /** False stands for an html page that never got shown: no ready, no height, or a missing field. */
  draws = true;

  lost(): boolean {
    return this.gone;
  }

  /** Stands for the tap that answers the question of the message on screen, and for Send after it. */
  answer: (value: number | string) => void = () => undefined;
  comment: (text: string) => void = () => undefined;
  /** Stands for an html page becoming ready later than present(). */
  draw: () => void = () => undefined;

  present(presentation: Presentation, drawn: () => void, answered: Answered, commented: Commented): Promise<Outcome> {
    if (this.fail) return Promise.reject(new Error('no DOM'));
    this.shown.push(presentation);
    this.answer = answered;
    this.comment = commented;
    this.draw = drawn;
    this.gone = false;
    return new Promise((resolve) => {
      this.settle = resolve;
      if (this.draws) drawn();
    });
  }

  dismiss(): void {
    this.finish({ kind: 'dismissed', reason: 'app' });
  }

  finish(outcome: Outcome): void {
    const settle = this.settle;
    this.settle = null;
    settle?.(outcome);
  }

  get ids(): string[] {
    return this.shown.map((p) => p.campaign.id);
  }
}

interface Harness {
  controller: InAppController;
  presenter: FakePresenter;
  storage: FakeStorage;
  clock: FakeClock;
  logger: Logger;
  reports: { id: string; name: string; properties: Json }[];
  syncs: Json[];
  /** Every timer but the fifteen minute sync, which every sync sets. */
  timers: { run: () => void; ms: number }[];
  periodic: { run: () => void; ms: number }[];
  errors: string[];
  state: {
    canRun: boolean;
    visible: boolean;
    session: string;
    response: SyncResult | Promise<SyncResult>;
    images: boolean;
    user: Json;
  };
  respond(campaigns: Json[], extra?: Json): void;
}

function harness(storage = new FakeStorage(), clock = new FakeClock(START), extra: Partial<ControllerDeps> = {}): Harness {
  const presenter = new FakePresenter();
  const reports: Harness['reports'] = [];
  const syncs: Json[] = [];
  const timers: Harness['timers'] = [];
  const periodic: Harness['periodic'] = [];
  const errors: string[] = [];
  const logger = new Logger();
  logger.setOnError((_code, message) => errors.push(message));
  const state: Harness['state'] = {
    canRun: true,
    visible: true,
    session: 's1',
    response: { ok: false, body: null },
    images: true,
    user: { first_name: 'Ana' },
  };
  let next = 0;
  const controller = new InAppController({
    storage,
    clock,
    logger,
    presenter,
    loadImage: () => Promise.resolve(state.images),
    device: () => ({
      platform: 'web',
      appVersion: '',
      osVersion: '',
      language: 'en',
      utcOffsetMinutes: 0,
      user: state.user,
      pushPermission: 'not_asked',
      orientation: 'portrait',
      unsupportedTemplates: [],
      unsupportedActions: ['request_push_permission', 'request_app_rating'],
    }),
    sync: (body) => {
      syncs.push(body);
      return Promise.resolve(state.response);
    },
    report: (id, name, properties) => reports.push({ id, name, properties }),
    newId: () => {
      next += 1;
      return `id${next}`;
    },
    sessionId: () => state.session,
    canRun: () => state.canRun,
    isVisible: () => state.visible,
    sdkVersion: '3.0',
    random: () => 0.5,
    setTimer: (run, ms) => (ms === 15 * 60_000 ? periodic : timers).push({ run, ms }),
    clearTimer: () => undefined,
    ...extra,
  });
  const respond = (campaigns: Json[], extra: Json = {}): void => {
    state.response = {
      ok: true,
      body: {
        campaigns_changed_at: 'c1',
        user_changed_at: 'u1',
        server_time: iso(clock.now()),
        first_seen_at: '2026-08-01T00:00:00Z',
        global_caps: { session: 10, day: 10 },
        campaigns,
        ...extra,
      },
    };
  };
  return { controller, presenter, storage, clock, logger, reports, syncs, timers, periodic, errors, state, respond };
}

/** Lets the promise chains inside the controller run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function started(h: Harness, campaigns: Json[], extra: Json = {}): Promise<void> {
  h.respond(campaigns, extra);
  h.controller.start();
  await settle();
}

describe('InAppController', () => {
  it('syncs on start, shows a message for a matching event, and reports the view under its id', async () => {
    const h = harness();
    await started(h, [campaign()]);
    expect(h.syncs[0]).toMatchObject({ format: 1, sdk_version: '3.0', campaigns_changed_at: null });

    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual(['c1']);
    expect(h.presenter.shown[0]?.rendered.title).toBe('Hello');
    expect(h.reports).toEqual([
      { id: 'id1', name: 'in_app_viewed', properties: { campaign_id: 'c1', revision: 1, template: 'interstitial' } },
    ]);
  });

  it('reports a click with the button and hands the payload to the host', async () => {
    const h = harness();
    const button = { id: 'b1', text: 'Go', action: { type: 'key_value', payload: { screen: 'offers' } } };
    await started(h, [campaign({ content: { buttons: [button] } })]);
    const clicks: unknown[] = [];
    h.controller.callbacks.onClicked = (id, buttonId, payload) => clicks.push([id, buttonId, payload]);

    h.controller.onEvent(CART);
    h.presenter.finish({ kind: 'clicked', buttonId: 'b1', action: { type: 'key_value', payload: { screen: 'offers' } } });
    await settle();

    expect(h.reports[1]).toMatchObject({ name: 'in_app_clicked', properties: { button_id: 'b1', action: 'key_value' } });
    expect(clicks).toEqual([['c1', 'b1', { screen: 'offers' }]]);
  });

  it('reports a dismissal with its reason', async () => {
    const h = harness();
    await started(h, [campaign()]);
    h.controller.onEvent(CART);
    h.presenter.finish({ kind: 'dismissed', reason: 'backdrop' });
    await settle();
    expect(h.reports[1]).toMatchObject({ name: 'in_app_dismissed', properties: { campaign_id: 'c1', reason: 'backdrop' } });
  });

  it('a delayed message waits, is decided again, and gains its view only when shown', async () => {
    const h = harness();
    await started(h, [campaign({ delay_seconds: 5, caps: { lifetime: 1 } })]);
    h.controller.onEvent({ type: 'event', name: 'cart_viewed' });
    expect(h.presenter.ids).toEqual([]);
    expect(h.reports).toEqual([]);
    const waits = h.timers.filter((timer) => timer.ms === 5000);
    expect(waits).toHaveLength(1);

    waits[0]?.run();
    expect(h.presenter.ids).toEqual(['c1']);
    expect(h.reports.map((report) => report.name)).toEqual(['in_app_viewed']);
  });

  it('a delayed message that no longer passes when its delay ends is dropped', async () => {
    const h = harness();
    const end = new Date(START + 3000).toISOString().replace(/\.\d+Z$/, 'Z');
    await started(h, [campaign({ delay_seconds: 5, schedule: { end_at: end } })]);
    h.controller.onEvent({ type: 'event', name: 'cart_viewed' });
    h.clock.advance(5000);
    h.timers.find((timer) => timer.ms === 5000)?.run();
    expect(h.presenter.ids).toEqual([]);
  });

  it('a delayed message never makes way for another campaign on the same event', async () => {
    const h = harness();
    const end = new Date(START + 3000).toISOString().replace(/\.\d+Z$/, 'Z');
    await started(h, [
      campaign({ id: 'late', priority: 9, delay_seconds: 5, schedule: { end_at: end } }),
      campaign({ id: 'plain' }),
    ]);
    h.controller.onEvent({ type: 'event', name: 'cart_viewed' });
    h.clock.advance(5000);
    h.timers.find((timer) => timer.ms === 5000)?.run();
    expect(h.presenter.ids).toEqual([]);
  });

  it('holds one delayed message and keeps the higher priority', async () => {
    const h = harness();
    await started(h, [
      campaign({ id: 'low', priority: 2, delay_seconds: 5, triggers: [{ type: 'event', name: 'a' }] }),
      campaign({ id: 'high', priority: 9, delay_seconds: 3, triggers: [{ type: 'event', name: 'b' }] }),
      campaign({ id: 'lower', priority: 1, delay_seconds: 1, triggers: [{ type: 'event', name: 'c' }] }),
    ]);
    for (const name of ['a', 'b', 'c']) h.controller.onEvent({ type: 'event', name });
    expect(h.timers.filter((timer) => [5000, 3000, 1000].includes(timer.ms)).map((timer) => timer.ms)).toEqual([5000, 3000]);
    h.timers.find((timer) => timer.ms === 3000)?.run();
    expect(h.presenter.ids).toEqual(['high']);
  });

  it('a delay that ends while another message is on screen takes the waiting place', async () => {
    const h = harness();
    await started(h, [
      campaign({ id: 'late', delay_seconds: 5, triggers: [{ type: 'event', name: 'a' }] }),
      campaign({ id: 'now', triggers: [{ type: 'event', name: 'b' }] }),
    ]);
    h.controller.onEvent({ type: 'event', name: 'a' });
    h.controller.onEvent({ type: 'event', name: 'b' });
    expect(h.presenter.ids).toEqual(['now']);
    h.timers.find((timer) => timer.ms === 5000)?.run();
    expect(h.presenter.ids).toEqual(['now']);
    h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
    await settle();
    expect(h.presenter.ids).toEqual(['now', 'late']);
  });

  it('stopping drops a delayed message', async () => {
    const h = harness();
    await started(h, [campaign({ delay_seconds: 5 })]);
    h.controller.onEvent({ type: 'event', name: 'cart_viewed' });
    h.controller.stop();
    h.timers.find((timer) => timer.ms === 5000)?.run();
    expect(h.presenter.ids).toEqual([]);
  });

  it('holds one message while another is on screen and keeps the higher priority', async () => {
    const h = harness();
    await started(h, [
      campaign({ id: 'first', triggers: [{ type: 'event', name: 'a' }] }),
      campaign({ id: 'low', priority: 2, triggers: [{ type: 'event', name: 'b' }] }),
      campaign({ id: 'high', priority: 9, triggers: [{ type: 'event', name: 'c' }] }),
      campaign({ id: 'lower', priority: 1, triggers: [{ type: 'event', name: 'd' }] }),
    ]);
    h.controller.onEvent({ type: 'event', name: 'a' });
    h.controller.onEvent({ type: 'event', name: 'b' });
    h.controller.onEvent({ type: 'event', name: 'c' });
    h.controller.onEvent({ type: 'event', name: 'd' });
    expect(h.presenter.ids).toEqual(['first']);

    h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
    await settle();
    expect(h.presenter.ids).toEqual(['first', 'high']);

    h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
    await settle();
    expect(h.presenter.ids).toEqual(['first', 'high']);
  });

  it('decides a waiting message again, and drops it when it no longer passes', async () => {
    const h = harness();
    await started(h, [
      campaign({ id: 'first', priority: 9, triggers: [{ type: 'event', name: 'a' }] }),
      campaign({ id: 'brief', triggers: [{ type: 'event', name: 'b' }], schedule: { end_at: iso(START + 60_000) } }),
    ]);
    h.controller.onEvent({ type: 'event', name: 'a' });
    h.controller.onEvent({ type: 'event', name: 'b' });
    h.clock.advanceMinutes(5);
    h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
    await settle();
    expect(h.presenter.ids).toEqual(['first']);
    expect(h.reports.filter((r) => r.name === 'in_app_viewed')).toHaveLength(1);
  });

  it('holds messages while paused, on an excluded screen, and while the page is hidden', async () => {
    const h = harness();
    await started(h, [campaign({ caps: { session: null } })]);

    h.controller.pause();
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual([]);
    h.controller.resume();
    expect(h.presenter.ids).toEqual(['c1']);
    h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
    await settle();

    h.controller.setExcludedScreens(['Checkout']);
    h.controller.onEvent({ type: 'screen_view', name: 'checkout' });
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual(['c1']);
    h.controller.onEvent({ type: 'screen_view', name: 'Home' });
    expect(h.presenter.ids).toEqual(['c1', 'c1']);
    h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
    await settle();

    h.state.visible = false;
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toHaveLength(2);
    h.state.visible = true;
    h.controller.onForeground();
    expect(h.presenter.ids).toHaveLength(3);
  });

  it('discard drops what is waiting and can close what is showing', async () => {
    const h = harness();
    await started(h, [
      campaign({ id: 'first', triggers: [{ type: 'event', name: 'a' }] }),
      campaign({ id: 'second', triggers: [{ type: 'event', name: 'b' }] }),
    ]);
    h.controller.onEvent({ type: 'event', name: 'a' });
    h.controller.onEvent({ type: 'event', name: 'b' });
    h.controller.discard(true);
    await settle();
    h.controller.resume();
    expect(h.presenter.ids).toEqual(['first']);
    expect(h.reports.map((r) => r.name)).toEqual(['in_app_viewed', 'in_app_dismissed']);
  });

  it('a vetoed message gains no view and reports nothing', async () => {
    const h = harness();
    await started(h, [campaign({ caps: { lifetime: 1 } })]);
    h.controller.callbacks.beforeShow = () => false;
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual([]);
    expect(h.reports).toEqual([]);

    delete h.controller.callbacks.beforeShow;
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual(['c1']);
  });

  it('shows the message when a host callback throws', async () => {
    const h = harness();
    await started(h, [campaign()]);
    h.controller.callbacks.beforeShow = () => {
      throw new Error('host bug');
    };
    h.controller.callbacks.onShown = () => {
      throw new Error('host bug');
    };
    expect(() => h.controller.onEvent(CART)).not.toThrow();
    expect(h.presenter.ids).toEqual(['c1']);
  });

  it('counts and reports nothing for a message that could not be drawn, and shows it next time', async () => {
    const h = harness();
    await started(h, [campaign({ caps: { lifetime: 1 } })]);
    h.presenter.fail = true;
    h.controller.onEvent(CART);
    await settle();
    expect(h.reports).toEqual([]);

    h.presenter.fail = false;
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual(['c1']);
    expect(h.reports.map((r) => r.name)).toEqual(['in_app_viewed']);
  });

  it('app_open waits for the sync in flight, so it is decided on fresh campaigns', async () => {
    const h = harness();
    let release: (result: SyncResult) => void = () => undefined;
    h.state.response = new Promise((resolve) => {
      release = resolve;
    });
    h.controller.start();
    h.controller.onEvent({ type: 'app_open' });
    expect(h.presenter.ids).toEqual([]);
    expect(h.timers.map((t) => t.ms)).toEqual([2000]);

    h.respond([campaign({ triggers: [{ type: 'app_open' }] })]);
    release(await h.state.response);
    await settle();
    expect(h.presenter.ids).toEqual(['c1']);
  });

  it('app_open stops waiting after two seconds and uses what is stored', async () => {
    const first = harness();
    await started(first, [campaign({ triggers: [{ type: 'app_open' }] })]);

    const h = harness(first.storage);
    h.state.session = 's2';
    h.state.response = new Promise(() => undefined);
    h.controller.start();
    h.controller.onEvent({ type: 'app_open' });
    expect(h.presenter.ids).toEqual([]);
    h.timers[0]?.run();
    expect(h.presenter.ids).toEqual(['c1']);
  });

  it('syncs again, after a random delay and only once, when the batch response shows a change', async () => {
    const h = harness();
    await started(h, [campaign()]);
    expect(h.syncs).toHaveLength(1);

    h.controller.onBatchResponse({ accepted: 1, in_app: { campaigns_changed_at: 'c1', user_changed_at: 'u1' } });
    expect(h.timers).toHaveLength(0);

    h.controller.onBatchResponse({ in_app: { campaigns_changed_at: 'c2', user_changed_at: 'u1' } });
    h.controller.onBatchResponse({ in_app: { campaigns_changed_at: 'c2', user_changed_at: 'u1' } });
    expect(h.timers.map((t) => t.ms)).toEqual([5000]);

    h.timers[0]?.run();
    await settle();
    expect(h.syncs).toHaveLength(2);
    expect(h.syncs[1]).toMatchObject({ campaigns_changed_at: 'c1', user_changed_at: 'u1' });
  });

  it('ignores a batch response with no in-app part', async () => {
    const h = harness();
    await started(h, [campaign()]);
    for (const body of [null, 'text', {}, { in_app: null }, { in_app: [] }]) h.controller.onBatchResponse(body);
    expect(h.timers).toHaveLength(0);
  });

  it('keeps the stored campaigns when a sync fails', async () => {
    const first = harness();
    await started(first, [campaign()]);

    const h = harness(first.storage);
    h.state.response = { ok: false, body: null };
    h.controller.start();
    await settle();
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual(['c1']);
  });

  it('keeps a lifetime cap across page loads', async () => {
    const first = harness();
    await started(first, [campaign({ caps: { lifetime: 1 } })]);
    first.controller.onEvent(CART);
    expect(first.presenter.ids).toEqual(['c1']);

    const h = harness(first.storage);
    await started(h, [campaign({ caps: { lifetime: 1 } })]);
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual([]);
  });

  it('keeps a session cap across a sync and a reload, and resets it with the session', async () => {
    const h = harness();
    await started(h, [campaign({ caps: { session: 1 } })]);
    h.controller.onEvent(CART);
    h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
    await settle();

    h.controller.onBatchResponse({ in_app: { campaigns_changed_at: 'c9' } });
    h.timers[0]?.run();
    await settle();
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual(['c1']);

    const reloaded = harness(h.storage);
    await started(reloaded, [campaign({ caps: { session: 1 } })]);
    reloaded.controller.onEvent(CART);
    expect(reloaded.presenter.ids).toEqual([]);

    reloaded.state.session = 's2';
    reloaded.controller.onEvent(CART);
    expect(reloaded.presenter.ids).toEqual(['c1']);
  });

  it("counts a view another tab recorded", async () => {
    const storage = new FakeStorage();
    const one = harness(storage);
    const two = harness(storage);
    await started(one, [campaign({ caps: { lifetime: 1 } })]);
    await started(two, [campaign({ caps: { lifetime: 1 } })]);

    one.controller.onEvent(CART);
    two.controller.onEvent(CART);
    expect(one.presenter.ids).toEqual(['c1']);
    expect(two.presenter.ids).toEqual([]);
  });

  it('does not show a campaign until its images have loaded', async () => {
    const h = harness();
    h.state.images = false;
    const image = { portrait: 'https://cdn.example/a.png', landscape: null };
    await started(h, [campaign({ content: { image } })]);
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual([]);

    h.state.images = true;
    h.controller.onBatchResponse({ in_app: { campaigns_changed_at: 'c2' } });
    h.timers[0]?.run();
    await settle();
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual(['c1']);
  });

  it('uses the server clock, so a wrong device clock cannot show an ended campaign', async () => {
    const wrong = new FakeClock(START - 7 * 86_400_000);
    const h = harness(new FakeStorage(), wrong);
    h.respond([campaign({ schedule: { end_at: iso(START - 60_000) } })], { server_time: iso(START) });
    h.controller.start();
    await settle();
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual([]);
  });

  it('shows nothing once the last sync is more than 48 hours old', async () => {
    const h = harness();
    await started(h, [campaign()]);
    h.state.response = { ok: false, body: null };
    h.clock.advance(48 * 3_600_000 + 1000);
    h.controller.onEvent(CART);
    await settle();
    expect(h.presenter.ids).toEqual([]);
  });

  it('an unchanged response keeps the campaigns and restarts the 48 hour clock', async () => {
    const h = harness();
    await started(h, [campaign()]);
    h.clock.advance(47 * 3_600_000);
    h.state.response = { ok: true, body: { unchanged: true, server_time: iso(h.clock.now()) } };
    h.controller.onForeground();
    await settle();
    h.clock.advance(2 * 3_600_000);
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual(['c1']);
  });

  it('syncs again after fifteen minutes of use', async () => {
    const h = harness();
    await started(h, [campaign()]);
    h.clock.advanceMinutes(16);
    h.controller.onEvent({ type: 'event', name: 'other' });
    await settle();
    expect(h.syncs).toHaveLength(2);
  });

  it('does nothing while the SDK may not run', async () => {
    const h = harness();
    h.state.canRun = false;
    h.respond([campaign()]);
    h.controller.start();
    await settle();
    h.controller.onEvent(CART);
    expect(h.syncs).toEqual([]);
    expect(h.presenter.ids).toEqual([]);

    h.state.canRun = true;
    h.controller.start();
    await settle();
    h.state.canRun = false;
    h.controller.onEvent(CART);
    h.controller.onBatchResponse({ in_app: { campaigns_changed_at: 'c2' } });
    expect(h.presenter.ids).toEqual([]);
    expect(h.timers).toEqual([]);
  });

  it('stop closes what is showing without reporting it, and clear wipes the store', async () => {
    const h = harness();
    await started(h, [campaign()]);
    h.controller.onEvent(CART);
    h.controller.stop();
    await settle();
    expect(h.reports.map((r) => r.name)).toEqual(['in_app_viewed']);

    expect(h.storage.get(IN_APP_KEY)).not.toBeNull();
    expect(h.storage.get(IN_APP_STATE_KEY)).not.toBeNull();
    h.controller.clear();
    expect(h.storage.get(IN_APP_KEY)).toBeNull();
    expect(h.storage.get(IN_APP_STATE_KEY)).toBeNull();
  });

  it('showing a message rewrites the small record, not the campaigns', async () => {
    const h = harness();
    await started(h, [campaign({ caps: { session: null } })]);
    const writes: string[] = [];
    const set = h.storage.set.bind(h.storage);
    h.storage.set = (key, value) => {
      writes.push(key);
      return set(key, value);
    };
    h.controller.onEvent(CART);
    h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
    await settle();
    h.controller.onEvent(CART);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes).not.toContain(IN_APP_KEY);
  });

  it('starts empty from a store it cannot read', async () => {
    const storage = new FakeStorage();
    for (const raw of ['not json', '[]', '{"campaigns":5}', '{"state":{"views":5}}', '{"state":5}']) {
      storage.set(IN_APP_KEY, raw);
      storage.set(IN_APP_STATE_KEY, raw);
      const h = harness(storage);
      await started(h, [campaign()]);
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1']);
    }
  });

  it('carries on in memory when the store refuses writes', async () => {
    const h = harness();
    h.storage.failWrites = true;
    await started(h, [campaign({ caps: { session: 1 } })]);
    h.controller.onEvent(CART);
    h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
    await settle();
    h.controller.onEvent(CART);
    expect(h.presenter.ids).toEqual(['c1']);
  });

  describe('review fixes', () => {
    it('sends a message that could not be drawn to the error callback', async () => {
      const h = harness();
      await started(h, [campaign()]);
      h.presenter.fail = true;
      h.controller.onEvent(CART);
      await settle();
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toContain('could not be drawn');
    });

    it('shows nothing when the host stops the SDK while it is asked', async () => {
      const h = harness();
      await started(h, [campaign()]);
      h.controller.callbacks.beforeShow = () => {
        h.state.canRun = false;
        return true;
      };
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual([]);
      expect(h.reports).toEqual([]);
    });

    it('uses the user as it is when the message is decided', async () => {
      const h = harness();
      await started(h, [campaign({ content: { title: 'Hi {{ user.first_name | default: "there" }}' } })]);
      h.state.user = { first_name: 'Bob' };
      h.controller.onEvent(CART);
      expect(h.presenter.shown[0]?.rendered.title).toBe('Hi Bob');
    });

    it('drops a delayed message when the page is hidden', async () => {
      const h = harness();
      await started(h, [campaign({ delay_seconds: 5 })]);
      h.controller.onEvent(CART);
      h.timers.find((timer) => timer.ms === 5000)?.run();
      h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
      await settle();

      h.state.visible = false;
      h.controller.onEvent(CART);
      h.timers.filter((timer) => timer.ms === 5000)[1]?.run();
      h.controller.onBackground();
      h.state.visible = true;
      h.controller.onForeground();
      expect(h.presenter.ids).toHaveLength(1);
    });

    it('names no button for a tap on the message', async () => {
      const h = harness();
      await started(h, [campaign()]);
      h.controller.onEvent(CART);
      h.presenter.finish({ kind: 'clicked', buttonId: null, action: { type: 'close' } });
      await settle();
      const click = h.reports.find((report) => report.name === 'in_app_clicked');
      expect(click).toBeDefined();
      expect(click?.properties).not.toHaveProperty('button_id');
    });

    it('syncs every fifteen minutes while the page is visible, with no events', async () => {
      const h = harness();
      await started(h, [campaign()]);
      h.periodic[h.periodic.length - 1]?.run();
      await settle();
      expect(h.syncs).toHaveLength(2);

      h.state.visible = false;
      h.periodic[h.periodic.length - 1]?.run();
      await settle();
      expect(h.syncs).toHaveLength(2);
    });

    it('forgets the campaigns after fourteen days without a sync and keeps the views', async () => {
      const storage = new FakeStorage();
      const first = harness(storage);
      await started(first, [campaign()]);
      first.controller.onEvent(CART);
      first.controller.stop();

      const later = harness(storage, new FakeClock(START + 15 * 86_400_000));
      later.controller.start();
      await settle();
      const synced = JSON.parse(storage.get(IN_APP_KEY) ?? '{}') as { campaigns: unknown[] };
      const kept = JSON.parse(storage.get(IN_APP_STATE_KEY) ?? '{}') as { state: { views: unknown[] } };
      expect(synced.campaigns).toEqual([]);
      expect(kept.state.views).toHaveLength(1);
    });

    it('tries a missing picture again after an unchanged answer', async () => {
      const h = harness();
      h.state.images = false;
      await started(h, [campaign({ content: { image: { portrait: 'https://cdn.example.com/a.png' } } })]);
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual([]);

      h.state.images = true;
      h.state.response = { ok: true, body: { unchanged: true, server_time: iso(h.clock.now()) } };
      h.clock.advance(61_000);
      h.controller.onForeground();
      await settle();
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1']);
    });

    it('takes app_open once per session, not once per page load', async () => {
      const open = campaign({ triggers: [{ type: 'app_open' }], caps: { session: null } });
      const first = harness();
      await started(first, [open]);
      first.controller.onEvent({ type: 'app_open' });
      expect(first.presenter.ids).toEqual(['c1']);

      const reload = harness(first.storage);
      await started(reload, [open]);
      reload.controller.onEvent({ type: 'app_open' });
      expect(reload.presenter.ids).toEqual([]);

      const later = harness(first.storage);
      later.state.session = 's2';
      await started(later, [open]);
      later.controller.onEvent({ type: 'app_open' });
      expect(later.presenter.ids).toEqual(['c1']);
    });

    it('keeps an opening message off an excluded screen tracked before in-app started', async () => {
      const h = harness();
      h.controller.setExcludedScreens(['Checkout']);
      h.controller.onEvent({ type: 'screen_view', name: 'checkout' });
      await started(h, [campaign({ triggers: [{ type: 'app_open' }] })]);
      h.controller.onEvent({ type: 'app_open' });
      await settle();
      expect(h.presenter.ids).toEqual([]);

      h.controller.onEvent({ type: 'screen_view', name: 'home' });
      expect(h.presenter.ids).toEqual(['c1']);
    });

    it('decides the screen the visit opened on once in-app has started', async () => {
      const h = harness();
      h.controller.onEvent({ type: 'screen_view', name: 'Pricing' });
      await started(h, [campaign({ triggers: [{ type: 'screen_view', name: 'pricing' }] })]);
      await settle();
      expect(h.presenter.ids).toEqual(['c1']);
    });

    it('keeps its limits in memory when the store refuses a write', async () => {
      const h = harness();
      await started(h, [campaign({ caps: { session: 1 } })]);
      h.storage.set = () => false;
      h.controller.onEvent(CART);
      h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
      await settle();
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1']);
    });

    it('frees the screen when the page took the message away', async () => {
      const h = harness();
      await started(h, [campaign({ caps: { session: null } })]);
      h.controller.onEvent(CART);
      h.presenter.gone = true;
      h.controller.onEvent(CART);
      await settle();
      expect(h.presenter.ids).toEqual(['c1', 'c1']);
    });

    it('does not show what waits while a link takes the person away', async () => {
      const h = harness();
      await started(h, [campaign({ caps: { session: null } })]);
      h.controller.onEvent(CART);
      h.controller.onEvent(CART);
      h.presenter.finish({ kind: 'clicked', buttonId: 'b1', action: { type: 'open_url', url: 'https://a.example' } });
      await settle();
      expect(h.presenter.ids).toEqual(['c1']);
      h.controller.onForeground();
      expect(h.presenter.ids).toEqual(['c1', 'c1']);
    });

    it('shows what waits at once when a link does not leave the page (mailto, tel, an app scheme)', async () => {
      for (const url of ['mailto:a@b.example', 'tel:+100', 'myapp://x']) {
        const h = harness();
        await started(h, [campaign({ caps: { session: null } })]);
        h.controller.onEvent(CART);
        h.controller.onEvent(CART);
        h.presenter.finish({ kind: 'clicked', buttonId: 'b1', action: { type: 'open_url', url } });
        await settle();
        expect(h.presenter.ids).toEqual(['c1', 'c1']);
      }
    });

    it('syncs on return to the page only when the last sync is over a minute old', async () => {
      const h = harness();
      await started(h, []);
      h.controller.onForeground();
      await settle();
      expect(h.syncs).toHaveLength(1);
      h.clock.advance(61_000);
      h.controller.onForeground();
      await settle();
      expect(h.syncs).toHaveLength(2);
    });

    it('handles an event that starts a new session during a sync after its app_open', async () => {
      const h = harness();
      await started(h, [
        campaign({ id: 'open', priority: 1, triggers: [{ type: 'app_open' }], caps: { session: null } }),
        campaign({ id: 'cart', priority: 9, caps: { session: null } }),
      ]);
      h.controller.onEvent({ type: 'app_open' });
      h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
      await settle();

      h.state.session = 's2';
      h.clock.advance(16 * 60_000);
      let release: (result: SyncResult) => void = () => undefined;
      h.state.response = new Promise((resolve) => (release = resolve));
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['open']);
      release({ ok: true, body: { unchanged: true, server_time: iso(h.clock.now()) } });
      await settle();
      expect(h.presenter.ids).toEqual(['open', 'open']);
    });

    it('closes a message the host discards from onShown', async () => {
      const h = harness();
      await started(h, [campaign()]);
      let closed = 0;
      const dismiss = h.presenter.dismiss.bind(h.presenter);
      h.presenter.dismiss = () => {
        closed += 1;
        dismiss();
      };
      h.controller.callbacks.onShown = () => h.controller.discard(true);
      h.controller.onEvent(CART);
      await settle();
      expect(closed).toBe(1);
      expect(h.reports.map((r) => r.name)).toEqual(['in_app_viewed', 'in_app_dismissed']);
    });

    it('sends a request of its own when restarted while a sync was in flight', async () => {
      const h = harness();
      h.state.response = new Promise(() => undefined);
      h.controller.start();
      h.controller.stop();
      h.respond([campaign()]);
      h.controller.start();
      await settle();
      expect(h.syncs).toHaveLength(2);
      expect(h.periodic.length).toBeGreaterThan(1);
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1']);
    });

    it('takes app_open when a page left open comes back to a new session', async () => {
      const h = harness();
      await started(h, [campaign({ triggers: [{ type: 'app_open' }], caps: { session: null } })]);
      h.controller.onEvent({ type: 'app_open' });
      h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
      await settle();

      h.controller.onForeground();
      await settle();
      expect(h.presenter.ids).toEqual(['c1']);
      h.state.session = 's2';
      h.controller.onForeground();
      await settle();
      expect(h.presenter.ids).toEqual(['c1', 'c1']);
    });

    it('makes a waiting message that became a delayed campaign wait out its delay', async () => {
      const h = harness();
      await started(h, [campaign()]);
      h.controller.pause();
      h.controller.onEvent(CART);
      h.respond([campaign({ id: 'c2', delay_seconds: 60 })], { campaigns_changed_at: 'c2' });
      h.clock.advance(61_000);
      h.controller.onForeground();
      await settle();
      h.controller.resume();
      expect(h.presenter.ids).toEqual([]);
      h.timers.find((timer) => timer.ms === 60_000)?.run();
      expect(h.presenter.ids).toEqual(['c2']);
    });

    it('shows a test message as it is, whatever its rules, and counts and reports nothing', async () => {
      const h = harness();
      const test = campaign({ id: 't1', triggers: [{ type: 'event', name: 'never' }], caps: { lifetime: 1 } });
      await started(h, [], { test_messages: [test] });
      expect(h.presenter.ids).toEqual(['t1']);
      h.presenter.finish({ kind: 'clicked', buttonId: null, action: { type: 'close' } });
      await settle();
      expect(h.reports).toEqual([]);
      const kept = JSON.parse(h.storage.get(IN_APP_STATE_KEY) ?? '{}') as { state: { views: unknown[] } };
      expect(kept.state.views).toEqual([]);
    });

    it('shows a test message after the message that is on screen', async () => {
      const h = harness();
      await started(h, [campaign()]);
      h.controller.onEvent(CART);
      h.respond([campaign()], { test_messages: [campaign({ id: 't1' })], campaigns_changed_at: 'c2' });
      h.clock.advance(61_000);
      h.controller.onForeground();
      await settle();
      expect(h.presenter.ids).toEqual(['c1']);
      h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
      await settle();
      expect(h.presenter.ids).toEqual(['c1', 't1']);
    });

    it('keeps a test message that arrived while the page was hidden, and shows it on return', async () => {
      const h = harness();
      h.state.visible = false;
      await started(h, [], { test_messages: [campaign({ id: 't1' })] });
      expect(h.presenter.ids).toEqual([]);
      h.state.visible = true;
      h.state.response = { ok: true, body: { unchanged: true, server_time: iso(h.clock.now()) } };
      h.controller.onForeground();
      await settle();
      expect(h.presenter.ids).toEqual(['t1']);
    });

    it('drops a test message with an action this SDK cannot perform', async () => {
      const h = harness();
      const button = { id: 'b1', text: 'Rate', action: { type: 'request_app_rating' } };
      await started(h, [], { test_messages: [campaign({ id: 't1', content: { buttons: [button] } })] });
      expect(h.presenter.ids).toEqual([]);
    });

    it('goes on to the next test message when one cannot be shown', async () => {
      const h = harness();
      const button = { id: 'b1', text: 'Rate', action: { type: 'request_app_rating' } };
      await started(h, [], { test_messages: [campaign({ id: 't1', content: { buttons: [button] } }), campaign({ id: 't2' })] });
      expect(h.presenter.ids).toEqual(['t2']);
    });

    it('holds a test message while the host has paused messages or is on an excluded screen', async () => {
      const h = harness();
      h.controller.pause();
      h.controller.setExcludedScreens(['checkout']);
      h.controller.onEvent({ type: 'screen_view', name: 'Checkout' });
      await started(h, [], { test_messages: [campaign({ id: 't1' })] });
      h.controller.resume();
      expect(h.presenter.ids).toEqual([]);
      h.controller.onEvent({ type: 'screen_view', name: 'Home' });
      expect(h.presenter.ids).toEqual(['t1']);
    });

    it('waits for the pictures of a test message with one timer at a time', async () => {
      const h = harness();
      h.state.images = false;
      const picture = { content: { image: { portrait: 'https://cdn.example.com/t.png' } } };
      await started(h, [], { test_messages: [campaign({ id: 't1', ...picture })] });
      h.controller.onForeground();
      h.controller.resume();
      expect(h.timers.filter((timer) => timer.ms === 1000)).toHaveLength(1);
    });

    it('keeps a test that still waits when another arrives, and shows both', async () => {
      const h = harness();
      await started(h, [campaign()]);
      h.controller.onEvent(CART);
      for (const [id, stamp] of [['t1', 'c2'], ['t2', 'c3']] as const) {
        h.clock.advance(61_000);
        h.respond([campaign()], { test_messages: [campaign({ id })], campaigns_changed_at: stamp });
        h.controller.onForeground();
        await settle();
      }
      for (let i = 0; i < 3; i += 1) {
        h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
        await settle();
      }
      expect(h.presenter.ids).toEqual(['c1', 't1', 't2']);
    });

    it('drops a test whose pictures never load and goes on to the next, which has its own tries', async () => {
      const h = harness();
      h.state.images = false;
      const picture = { content: { image: { portrait: 'https://cdn.example.com/t.png' } } };
      await started(h, [], { test_messages: [campaign({ id: 't1', ...picture }), campaign({ id: 't2' })] });
      for (let i = 0; i < 10; i += 1) h.timers.filter((timer) => timer.ms === 1000)[i]?.run();
      expect(h.presenter.ids).toEqual(['t2']);
    });
  });
  describe('questions', () => {
    const QUESTION = { id: 'q1', type: 'stars', options: [], comment: null, thanks: null, review_from: null };
    const asking = (changes: Json = {}): Json => campaign(merge({ content: { question: QUESTION }, revision: 3 }, changes));
    const stored = (h: Harness): string[] | undefined =>
      (JSON.parse(h.storage.get(IN_APP_STATE_KEY) ?? '{}') as { state: { answered?: string[] } }).state.answered;

    it('reports the answer at the tap, before the message has closed', async () => {
      const h = harness();
      await started(h, [asking()]);
      const answered: unknown[] = [];
      h.controller.callbacks.onAnswered = (...all) => answered.push(all);
      h.controller.onEvent(CART);
      expect(h.presenter.shown[0]?.campaign.content.question).toMatchObject({ id: 'q1', type: 'stars' });

      h.presenter.answer(4);
      expect(h.reports.map((r) => r.name)).toEqual(['in_app_viewed', 'in_app_answered']);
      expect(h.reports[1]).toEqual({
        id: 'id2',
        name: 'in_app_answered',
        properties: { campaign_id: 'c1', revision: 3, question_id: 'q1', type: 'stars', value: 4 },
      });
      expect(stored(h)).toEqual(['c1']);
      expect(answered).toEqual([]);

      h.presenter.finish({ kind: 'answered', value: 4, comment: null });
      await settle();
      expect(h.reports.map((r) => r.name)).toEqual(['in_app_viewed', 'in_app_answered']);
      expect(answered).toEqual([['c1', 4, null]]);
    });

    it('reports the option of a choice by its id', async () => {
      const h = harness();
      const options = [
        { id: 'search', text: 'Search' },
        { id: 'friend', text: 'A friend' },
      ];
      await started(h, [asking({ content: { question: { type: 'choice', options } } })]);
      h.controller.onEvent(CART);
      h.presenter.answer('friend');
      expect(h.reports[1]?.properties).toMatchObject({ question_id: 'q1', type: 'choice', value: 'friend' });
    });

    it('reports a comment at Send, before the message has closed, and not again when it does', async () => {
      const h = harness();
      await started(h, [asking({ id: 'a', triggers: [{ type: 'event', name: 'a' }] }), asking({ id: 'b', triggers: [{ type: 'event', name: 'b' }] })]);
      const answered: unknown[] = [];
      const dismissed: unknown[] = [];
      h.controller.callbacks.onAnswered = (...all) => answered.push(all);
      h.controller.callbacks.onDismissed = (...all) => dismissed.push(all);
      h.controller.callbacks.onClicked = (...all) => dismissed.push(all);

      h.controller.onEvent({ type: 'event', name: 'a' });
      h.presenter.answer(2);
      h.presenter.comment('Too slow');
      expect(h.reports.map((r) => r.name)).toEqual(['in_app_viewed', 'in_app_answered', 'in_app_commented']);
      expect(h.reports[2]?.properties).toEqual({
        campaign_id: 'a',
        revision: 3,
        question_id: 'q1',
        type: 'stars',
        value: 2,
        comment: 'Too slow',
      });
      expect(answered).toEqual([]);
      h.presenter.finish({ kind: 'answered', value: 2, comment: 'Too slow' });
      await settle();
      expect(h.reports.map((r) => r.name)).toEqual(['in_app_viewed', 'in_app_answered', 'in_app_commented']);

      h.controller.onEvent({ type: 'event', name: 'b' });
      h.presenter.answer(5);
      h.presenter.finish({ kind: 'answered', value: 5, comment: null });
      await settle();
      expect(h.reports.slice(3).map((r) => r.name)).toEqual(['in_app_viewed', 'in_app_answered']);
      expect(answered).toEqual([
        ['a', 2, 'Too slow'],
        ['b', 5, null],
      ]);
      expect(dismissed).toEqual([]);
    });

    it('reports no comment before an answer', async () => {
      const h = harness();
      await started(h, [asking()]);
      h.controller.onEvent(CART);
      h.presenter.comment('Stray');
      expect(h.reports.map((r) => r.name)).toEqual(['in_app_viewed']);
    });

    it('shows a campaign whose stored answers are not a list of ids', async () => {
      for (const answered of ['c1', 5, { c1: true }, ['c1', 2]]) {
        const h = harness();
        h.storage.set(
          IN_APP_STATE_KEY,
          JSON.stringify({ sessionId: 's1', state: { views: [], session: [], counts: {}, syncedAt: START, answered } }),
        );
        await started(h, [asking()]);
        h.controller.onEvent(CART);
        expect(h.presenter.ids, JSON.stringify(answered)).toEqual(['c1']);
        expect(stored(h)).toEqual([]);
      }
    });

    it('a question closed before it was answered is a dismissal, and is asked again', async () => {
      const h = harness();
      await started(h, [asking()]);
      const answered: unknown[] = [];
      h.controller.callbacks.onAnswered = (...all) => answered.push(all);
      h.controller.onEvent(CART);
      h.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
      await settle();
      expect(h.reports.map((r) => r.name)).toEqual(['in_app_viewed', 'in_app_dismissed']);
      expect(answered).toEqual([]);
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1', 'c1']);
    });

    it('does not ask again after an answer, nor after a restart from what is stored', async () => {
      const h = harness();
      await started(h, [asking()]);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      h.controller.debug = true;
      h.logger.setLevel('info');
      h.controller.onEvent(CART);
      h.presenter.answer(5);
      h.presenter.finish({ kind: 'answered', value: 5, comment: null });
      await settle();

      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1']);
      expect(info.mock.lastCall?.[0]).toContain('Skipped c1: answered');

      const restarted = harness(h.storage);
      restarted.state.session = 's2';
      await started(restarted, [asking()]);
      restarted.controller.onEvent(CART);
      expect(restarted.presenter.ids).toEqual([]);
    });

    it('keeps the answer when a sync replaced the engine while the message was on screen', async () => {
      const h = harness();
      await started(h, [asking()]);
      h.controller.onEvent(CART);
      h.respond([asking()], { campaigns_changed_at: 'c2' });
      h.controller.onForeground();
      await settle();
      h.presenter.answer(5);
      h.presenter.finish({ kind: 'answered', value: 5, comment: null });
      await settle();
      expect(stored(h)).toEqual(['c1']);
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1']);
    });

    it('shows a campaign triggered by the answer once the first has closed', async () => {
      const h = harness();
      const onAnswer = (id: string, op: string): Json =>
        campaign({
          id,
          triggers: [
            {
              type: 'event',
              name: 'in_app_answered',
              filters: [
                { field: 'campaign_id', op: 'eq', value: 'c1' },
                { field: 'question_id', op: 'eq', value: 'q1' },
                { field: 'type', op: 'eq', value: 'stars' },
                { field: 'value', op, value: 3 },
              ],
            },
          ],
        });
      await started(h, [asking(), onAnswer('unhappy', 'lt'), onAnswer('happy', 'gt')]);
      h.controller.onEvent(CART);
      h.presenter.answer(5);
      expect(h.presenter.ids).toEqual(['c1']);

      h.presenter.finish({ kind: 'answered', value: 5, comment: null });
      await settle();
      expect(h.presenter.ids).toEqual(['c1', 'happy']);
    });

    it('a test message with a question reports nothing, records no answer and triggers nothing', async () => {
      const h = harness();
      const follow = campaign({ id: 'follow', triggers: [{ type: 'event', name: 'in_app_answered' }] });
      await started(h, [follow], { test_messages: [asking({ id: 't1' })] });
      const answered: unknown[] = [];
      h.controller.callbacks.onAnswered = (...all) => answered.push(all);
      expect(h.presenter.shown[0]?.campaign.content.question).not.toBeNull();

      h.presenter.answer(5);
      h.presenter.comment('Looks right');
      h.presenter.finish({ kind: 'answered', value: 5, comment: 'Looks right' });
      await settle();
      expect(h.reports).toEqual([]);
      expect(answered).toEqual([]);
      expect(stored(h) ?? []).toEqual([]);
      expect(h.presenter.ids).toEqual(['t1']);
    });
  });

  describe('html messages', () => {
    const PAGE = '<!doctype html><p>Hi</p>';
    const html = (changes: Json = {}): Json =>
      campaign(merge({ template: 'html', content: { html: PAGE, layout: 'modal' } }, changes));
    const stamp = (h: Harness): unknown => (JSON.parse(h.storage.get(IN_APP_KEY) ?? '{}') as Json).campaignsChangedAt;

    function htmlHarness(storage = new FakeStorage()) {
      const sent: { tracked: [string, Json][]; attributes: [string, unknown][] } = { tracked: [], attributes: [] };
      const h = harness(storage, new FakeClock(START), {
        track: (name, properties) => sent.tracked.push([name, properties]),
        setAttribute: (key, value) => sent.attributes.push([key, value]),
      });
      return { h, sent };
    }

    async function shown(h: Harness, campaigns: Json[], event: EngineEvent = CART) {
      h.respond(campaigns);
      h.controller.start();
      await settle();
      h.controller.onEvent(event);
      const page = h.presenter.shown.at(-1)?.page;
      if (!page) throw new Error('no html page presented');
      return page;
    }

    it('keeps html bodies in memory only, storing no body and a null campaigns stamp', async () => {
      const { h } = htmlHarness();
      const page = await shown(h, [html(), campaign({ id: 'c2' })]);
      expect(page.body).toBe(PAGE);
      expect(h.storage.get(IN_APP_KEY)).not.toContain('<p>Hi</p>');
      expect(h.storage.get(IN_APP_KEY)).toContain('"c2"');
      expect(stamp(h)).toBeNull();
    });

    it('a reload with a null stamp holds an early event until the sync is back, then shows the html campaign', async () => {
      const { h } = htmlHarness();
      await shown(h, [html()]);
      const again = htmlHarness(h.storage).h;
      again.respond([html()]);
      again.controller.start();
      again.controller.onEvent(CART);
      expect(again.presenter.ids).toEqual([]);
      expect(again.syncs[0]).toMatchObject({ campaigns_changed_at: null });
      await settle();
      expect(again.presenter.shown.map((shown) => shown.page?.body)).toEqual([PAGE]);
    });

    it('a stored stamp holds no ordinary event while the sync is in flight', async () => {
      const first = harness();
      await started(first, [campaign()]);
      const h = harness(first.storage);
      h.state.response = new Promise(() => undefined);
      h.controller.start();
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1']);
      expect(h.timers).toEqual([]);
    });

    it('with a null stamp, a slow sync releases held events after two seconds', async () => {
      const { h } = htmlHarness();
      await started(h, [html({ triggers: [{ type: 'event', name: 'other' }] }), campaign({ id: 'c2' })]);
      const again = htmlHarness(h.storage).h;
      again.state.response = new Promise(() => undefined);
      again.controller.start();
      again.controller.onEvent(CART);
      expect(again.presenter.ids).toEqual([]);
      expect(again.timers.map((t) => t.ms)).toEqual([2000]);
      again.timers[0]?.run();
      expect(again.presenter.ids).toEqual(['c2']);
      again.presenter.finish({ kind: 'dismissed', reason: 'close_button' });
      await settle();
      again.controller.onEvent(CART);
      expect(again.presenter.ids).toEqual(['c2', 'c2']);
    });

    it('a list cut down to the storage budget persists a null stamp', () => {
      const storage = new FakeStorage();
      const big = (id: string): Json => campaign({ id, padding: 'x'.repeat(300_000) });
      saveSynced(storage, { ...emptySynced(), campaigns: [big('a'), big('b')], campaignsChangedAt: 'c1' });
      const saved = JSON.parse(storage.get(IN_APP_KEY) ?? '{}') as Json;
      expect((saved.campaigns as unknown[]).length).toBe(1);
      expect(saved.campaignsChangedAt).toBeNull();
    });

    it('a native-only list keeps its stamp, so the next sync can answer unchanged', async () => {
      const { h } = htmlHarness();
      await started(h, [campaign()]);
      expect(stamp(h)).toBe('c1');
      const again = htmlHarness(h.storage).h;
      again.state.response = { ok: true, body: { unchanged: true, server_time: iso(again.clock.now()) } };
      again.controller.start();
      await settle();
      expect(again.syncs[0]).toMatchObject({ campaigns_changed_at: 'c1' });
      again.controller.onEvent(CART);
      expect(again.presenter.ids).toEqual(['c1']);
    });

    it('another tab writing the store does not drop this tab\'s html campaign', async () => {
      const { h } = htmlHarness();
      h.respond([html()]);
      h.controller.start();
      await settle();
      const other = harness(h.storage);
      await started(other, [campaign({ id: 'c2', triggers: [{ type: 'event', name: 'other' }] })]);
      other.controller.onEvent({ type: 'event', name: 'other' });
      h.state.response = { ok: true, body: { unchanged: true, server_time: iso(h.clock.now()) } };
      h.controller.onForeground();
      await settle();
      h.controller.onEvent(CART);
      expect(h.presenter.shown.map((shown) => shown.page?.body)).toEqual([PAGE]);
    });

    it('hands the page the user and the event that triggered it', async () => {
      const { h } = htmlHarness();
      const page = await shown(h, [html()], { type: 'event', name: 'cart_viewed', properties: { sku: 'A1' } });
      expect(page.user).toEqual({ first_name: 'Ana' });
      expect(page.event).toEqual({ sku: 'A1' });
    });

    it('a page never shown by the deadline uses no cap, reports nothing and stops winning its trigger', async () => {
      const { h } = htmlHarness();
      h.presenter.draws = false;
      await shown(h, [html({ priority: 9, caps: { lifetime: 1 } }), campaign({ id: 'c2', priority: 1 })]);
      h.presenter.finish({ kind: 'dismissed', reason: 'failed' });
      await settle();
      expect(h.reports).toEqual([]);
      expect(h.storage.get(IN_APP_STATE_KEY)).not.toContain('"campaign":"c1"');

      h.presenter.draws = true;
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1', 'c2']);
      expect(h.reports.map((report) => report.name)).toEqual(['in_app_viewed']);
    });

    it('a missing field fails only that show: once the attribute is set, a later trigger shows it', async () => {
      const { h } = htmlHarness();
      h.presenter.draws = false;
      await shown(h, [html({ priority: 9 }), campaign({ id: 'c2', priority: 1 })]);
      h.presenter.finish({ kind: 'dismissed', reason: 'failed', missing: true });
      await settle();
      expect(h.reports).toEqual([]);

      h.presenter.draws = true;
      h.state.user = { first_name: 'Ana', plan: 'pro' };
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1', 'c1']);
      expect(h.reports.map((report) => report.name)).toEqual(['in_app_viewed']);
    });

    it('shows an html page whose leftover native picture never loads', async () => {
      const { h } = htmlHarness();
      h.state.images = false;
      await shown(h, [html({ content: { image: { portrait: 'https://cdn.example.com/gone.png' } } })]);
      expect(h.presenter.ids).toEqual(['c1']);
    });

    it('asks again before the page is revealed, and one withdrawn then is not counted as failed', async () => {
      const { h } = htmlHarness();
      h.presenter.draws = false;
      const page = await shown(h, [html()]);
      expect(page.eligible()).toBe(true);
      h.controller.pause();
      expect(page.eligible()).toBe(false);
      h.controller.resume();
      h.controller.setExcludedScreens(['checkout']);
      h.controller.onEvent({ type: 'screen_view', name: 'Checkout' });
      expect(page.eligible()).toBe(false);
      h.presenter.finish({ kind: 'dismissed', reason: 'failed' });
      await settle();
      expect(h.reports).toEqual([]);

      h.controller.setExcludedScreens([]);
      h.presenter.draws = true;
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1', 'c1']);
    });

    it('a page dismissed before it was revealed reports no dismissal and is not counted as failed', async () => {
      const { h } = htmlHarness();
      const dismissed: unknown[] = [];
      h.controller.callbacks.onDismissed = (...args) => dismissed.push(args);
      h.presenter.draws = false;
      await shown(h, [html()]);
      h.controller.discard(true);
      await settle();
      expect(h.reports).toEqual([]);
      expect(dismissed).toEqual([]);

      h.controller.resume();
      h.presenter.draws = true;
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1', 'c1']);
    });

    it('a page withdrawn by a pause while it loaded waits and shows on resume', async () => {
      const { h } = htmlHarness();
      h.presenter.draws = false;
      const page = await shown(h, [html()]);
      h.controller.pause();
      expect(page.eligible()).toBe(false);
      h.presenter.finish({ kind: 'dismissed', reason: 'failed' });
      await settle();
      expect(h.presenter.ids).toEqual(['c1']);
      expect(h.reports).toEqual([]);

      h.presenter.draws = true;
      h.controller.resume();
      expect(h.presenter.ids).toEqual(['c1', 'c1']);
      expect(h.reports.map((report) => report.name)).toEqual(['in_app_viewed']);
    });

    it('a page still loading when the host discards is dropped, not shown on resume', async () => {
      const { h } = htmlHarness();
      h.presenter.draws = false;
      const page = await shown(h, [html()]);
      h.controller.discard();
      expect(page.eligible()).toBe(false);
      h.presenter.finish({ kind: 'dismissed', reason: 'failed' });
      await settle();

      h.presenter.draws = true;
      h.controller.resume();
      expect(h.presenter.ids).toEqual(['c1']);
      expect(h.reports).toEqual([]);
    });

    it('a deadline in a hidden tab is a withdrawal: not failed, shown once the tab is back', async () => {
      const { h } = htmlHarness();
      h.presenter.draws = false;
      const page = await shown(h, [html()]);
      h.state.visible = false;
      expect(page.eligible()).toBe(false);
      h.presenter.finish({ kind: 'dismissed', reason: 'failed' });
      await settle();

      h.presenter.draws = true;
      h.state.visible = true;
      h.controller.onForeground();
      await settle();
      expect(h.presenter.ids).toEqual(['c1', 'c1']);
      expect(h.reports.map((report) => report.name)).toEqual(['in_app_viewed']);
    });

    it('a campaign removed by a sync while its page loaded is withdrawn, uncounted and not shown again', async () => {
      const { h } = htmlHarness();
      h.presenter.draws = false;
      const page = await shown(h, [html()]);
      h.respond([]);
      h.clock.advance(61_000);
      h.controller.onForeground();
      await settle();
      expect(page.eligible()).toBe(false);
      h.presenter.finish({ kind: 'dismissed', reason: 'failed' });
      await settle();
      expect(h.reports).toEqual([]);

      h.presenter.draws = true;
      h.controller.onEvent(CART);
      expect(h.presenter.ids).toEqual(['c1']);
    });

    it('track counts the view\'s click at once with campaign_id, and a later open does not count again', async () => {
      const { h, sent } = htmlHarness();
      const clicks: unknown[] = [];
      h.controller.callbacks.onClicked = (...args) => clicks.push(args);
      const page = await shown(h, [html()]);

      page.actions.track('liked', { stars: 5 });
      page.actions.track('again', {});
      expect(sent.tracked).toEqual([
        ['liked', { stars: 5, campaign_id: 'c1' }],
        ['again', { campaign_id: 'c1' }],
      ]);
      expect(h.reports.slice(1)).toEqual([
        { id: expect.any(String), name: 'in_app_clicked', properties: { campaign_id: 'c1', revision: 1, action: 'track' } },
      ]);

      h.presenter.finish({ kind: 'clicked', buttonId: null, action: { type: 'open_url', url: 'https://acme.example' } });
      await settle();
      expect(h.reports.filter((report) => report.name === 'in_app_clicked')).toHaveLength(1);
      expect(clicks).toEqual([['c1', null, null]]);
    });

    it('an open alone counts the click once', async () => {
      const { h } = htmlHarness();
      await shown(h, [html()]);
      h.presenter.finish({ kind: 'clicked', buttonId: null, action: { type: 'open_url', url: 'https://acme.example' } });
      await settle();
      expect(h.reports.slice(1).map((report) => [report.name, report.properties])).toEqual([
        ['in_app_clicked', { campaign_id: 'c1', revision: 1, action: 'open_url' }],
      ]);
    });

    it('setAttribute goes to the SDK', async () => {
      const { h, sent } = htmlHarness();
      const page = await shown(h, [html()]);
      page.actions.setAttribute('plan', 'pro');
      expect(sent.attributes).toEqual([['plan', 'pro']]);
    });

    it('a test message logs track and setAttribute instead of sending them', async () => {
      const { h, sent } = htmlHarness();
      const logged = vi.spyOn(h.logger, 'info');
      h.respond([], { test_messages: [html({ id: 't1' })] });
      h.controller.start();
      await vi.waitFor(() => expect(h.presenter.shown).toHaveLength(1));
      const page = h.presenter.shown[0]?.page;
      expect(page?.body).toBe(PAGE);
      page?.actions.track('liked', {});
      page?.actions.setAttribute('plan', 'pro');
      expect(sent).toEqual({ tracked: [], attributes: [] });
      expect(h.reports).toEqual([]);
      expect(logged.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/track liked[\s\S]*setAttribute plan/);
    });

    it('ignores native fields left over from an earlier template', async () => {
      const { h } = htmlHarness();
      const leftover = {
        title: '{{ user.missing }}',
        buttons: [{ id: 'b1', text: '{{ user.missing }}', action: { type: 'open_url', url: 'javascript:alert(1)' } }],
        tap_action: { type: 'request_push_permission' },
      };
      const page = await shown(h, [html({ content: leftover })]);
      expect(page.body).toBe(PAGE);
      expect(h.reports.map((report) => report.name)).toEqual(['in_app_viewed']);
    });

    it('records the view on the current engine when another tab showed a message while the page loaded', async () => {
      const { h } = htmlHarness();
      h.presenter.draws = false;
      await shown(h, [html()]);
      const other = harness(h.storage);
      await started(other, [campaign({ id: 'c2', triggers: [{ type: 'event', name: 'other' }] })]);
      other.controller.onEvent({ type: 'event', name: 'other' });
      expect(other.presenter.ids).toEqual(['c2']);

      h.presenter.draw();
      const kept = JSON.parse(h.storage.get(IN_APP_STATE_KEY) ?? '{}') as { state: { views: { campaign: string }[] } };
      expect(kept.state.views.map((view) => view.campaign)).toEqual(['c2', 'c1']);
      expect(h.reports.map((report) => report.name)).toEqual(['in_app_viewed']);
    });
  });
});
