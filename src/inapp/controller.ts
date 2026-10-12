import type { Clock } from '../core/clock';
import type { Logger } from '../logging/logger';
import { GrovsError } from '../net/errors';
import type { Storage } from '../storage/storage';
import { readCampaign, readTimestamp } from './definition';
import { Engine } from './engine';
import { ImageCache, type ImageLoader } from './images';
import { render } from './personalize';
import {
  clear,
  emptyKept,
  emptySynced,
  isHtml,
  loadKept,
  loadSynced,
  saveKept,
  saveSynced,
  type Kept,
  type Synced,
} from './store';
import type { Action, Campaign, Decision, Device, EngineEvent, GlobalCaps, Question, Rendered } from './types';

/**
 * Connects the engine to the SDK: what it stores, when it syncs, what it
 * shows and what it reports.
 *
 * The engine decides; this class does everything the engine must not: read
 * the clock, touch storage, call the network, draw. It holds one message on
 * screen and at most one waiting, and a message that waited is decided again
 * before it is drawn.
 */

const SYNC_EVERY = 15 * 60_000;
const OPEN_WAIT = 2_000;
const JITTER = 10_000;
const TEST_TRIES = 10;
const FORGET_AFTER = 14 * 86_400_000;
const FORMAT = 1;

/** What an html message's page may ask of the SDK besides closing and opening a link. */
export interface PageActions {
  track(name: string, properties: Record<string, unknown>): void;
  setAttribute(key: string, value: unknown): void;
}

export interface Page {
  body: string;
  user: Record<string, unknown>;
  event: Record<string, unknown>;
  actions: PageActions;
  /** Asked again right before the page is revealed; false tears it down as never shown. */
  eligible: () => boolean;
}

export interface Presentation {
  campaign: Campaign;
  rendered: Rendered;
  /** Set for the html template. */
  page?: Page | undefined;
}

export type Outcome =
  | { kind: 'clicked'; buttonId: string | null; action: Action }
  | { kind: 'dismissed'; reason: 'close_button' | 'backdrop' | 'swipe' | 'replaced' | 'app' | 'orientation' }
  /** The question was answered, however the message closed afterwards. */
  | { kind: 'answered'; value: number | string; comment: string | null }
  /** Never drawn: nothing is reported for it. `missing`: a personalization field had no value. */
  | { kind: 'dismissed'; reason: 'failed'; missing?: true };

export type Answered = (value: number | string) => void;
export type Commented = (text: string) => void;

export interface Presenter {
  /**
   * Calls `drawn` once the message is on the page, and not at all when it could not be put there.
   * Calls `answered` at the tap that answers its question, before anything else is asked, and
   * `commented` at Send with the trimmed text, when there is any: neither waits for the message to close.
   */
  present(presentation: Presentation, drawn: () => void, answered: Answered, commented: Commented): Promise<Outcome>;
  /** Closes what is on screen; its promise resolves as dismissed by the app. */
  dismiss(): void;
  /** True when the page removed the message itself, as a page swap does. */
  lost?(): boolean;
}

export interface InAppCallbacks {
  /** Return false to stop a message. It gains no view, and nothing else shows for that event. */
  beforeShow?: (campaignId: string) => boolean;
  onShown?: (campaignId: string) => void;
  onClicked?: (campaignId: string, buttonId: string | null, payload: Record<string, unknown> | null) => void;
  onDismissed?: (campaignId: string, reason: string) => void;
  /** Called once the message has closed; `value` is a number, or the option's id for a choice. */
  onAnswered?: (campaignId: string, value: number | string, comment: string | null) => void;
}

export interface SyncResult {
  ok: boolean;
  body: unknown;
}

export interface ControllerDeps {
  storage: Storage;
  clock: Clock;
  logger: Logger;
  presenter: Presenter;
  loadImage: ImageLoader;
  /** Everything about the device except what the sync supplies. */
  device: () => Omit<Device, 'firstSeenAt'>;
  sync: (body: Record<string, unknown>) => Promise<SyncResult>;
  /** Queues a reserved in-app event with a fixed id, so a view's id is its event's id. */
  report: (id: string, name: string, properties: Record<string, unknown>) => void;
  newId: () => string;
  /** The SDK's session, which rotates after 30 idle minutes and is shared across tabs. */
  sessionId: () => string;
  /** False while the SDK is disabled, retired, or waiting for consent or authentication. */
  canRun: () => boolean;
  isVisible: () => boolean;
  sdkVersion: string;
  /** The SDK's event API, for an html page's grovs.track. */
  track?: (name: string, properties: Record<string, unknown>) => void;
  /** The SDK's attribute API, for an html page's grovs.setAttribute. */
  setAttribute?: (key: string, value: unknown) => void;
  random?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Waiting {
  event: EngineEvent;
  priority: number;
  /** Set for a message that waited out a delay: show this campaign or nothing. */
  only?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function capsOf(value: unknown): GlobalCaps {
  const read = (cap: unknown): number | null => (typeof cap === 'number' && Number.isInteger(cap) && cap > 0 ? cap : null);
  return isObject(value) ? { session: read(value.session), day: read(value.day) } : { session: null, day: null };
}

function answerOf(question: Question, value: number | string): Record<string, unknown> {
  return { question_id: question.id, type: question.type, value };
}

export class InAppController {
  readonly callbacks: InAppCallbacks = {};
  private synced: Synced = emptySynced();
  private kept: Kept = emptyKept();
  private raw: string | null = null;
  private engine: Engine | null = null;
  private readonly images: ImageCache;
  private running = false;
  private paused = false;
  private showing: string | null = null;
  private waiting: Waiting | null = null;
  // Bumped by discard(), so a page still loading then is dropped rather than queued again.
  private discards = 0;
  private excluded = new Set<string>();
  private screen: string | null = null;
  private syncing: Promise<void> | null = null;
  private syncTimer: unknown = null;
  private periodic: unknown = null;
  private readonly reported = new Set<string>();
  private lastSyncAttempt = 0;
  private held: { timer: unknown; events: EngineEvent[] } | null = null;
  /** A null stored stamp means html campaigns were live: every event waits for the first sync, which brings them. */
  private holdAll = false;
  /** The screen the visit opened on, tracked before in-app could run. */
  private landing: EngineEvent | null = null;
  /** True from the start of a session until its app_open has been taken. */
  private fresh = false;
  /** Messages sent from the dashboard to look at; shown as they are, counted nowhere. */
  private tests: unknown[] = [];
  private testTries = 0;
  private testTimer: unknown = null;
  /** Set when the store refused a write: memory is then newer than what is stored. */
  private unsaved = false;
  /** html campaigns that failed to show in this page load, so they stop winning their trigger. */
  private readonly failedHtml = new Set<string>();
  private delayed: { timer: unknown; priority: number } | null = null;
  private generation = 0;
  debug = false;

  constructor(private readonly deps: ControllerDeps) {
    this.images = new ImageCache(deps.loadImage);
  }

  /** Called once authentication has succeeded. */
  start(): void {
    if (this.running || !this.deps.canRun()) return;
    this.running = true;
    this.generation += 1;
    this.reload(true);
    this.holdAll = this.synced.campaignsChangedAt === null;
    this.followSession();
    void this.sync();
    if (this.landing) this.hold(this.landing);
    this.landing = null;
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.cancelTimers();
    this.waiting = null;
    this.tests = [];
    // Its answer belongs to the run that ended; a restart must send a request of its own.
    this.syncing = null;
    this.deps.presenter.dismiss();
  }

  /** For reset(): the stored campaigns, views and counts belong to the visitor being cleared. */
  clear(): void {
    this.stop();
    clear(this.deps.storage);
    this.synced = emptySynced();
    this.kept = emptyKept();
    this.raw = null;
    this.engine = null;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.showWaiting();
  }

  /** Drops what is waiting; with `dismiss`, also closes what is on screen. Stays paused. */
  discard(dismiss = false): void {
    this.paused = true;
    this.discards += 1;
    this.waiting = null;
    if (this.delayed) this.cancel(this.delayed.timer);
    this.delayed = null;
    if (this.held) this.cancel(this.held.timer);
    this.held = null;
    if (dismiss) this.deps.presenter.dismiss();
  }

  setExcludedScreens(names: readonly string[]): void {
    this.excluded = new Set(names.map((name) => name.toLowerCase()));
    this.showWaiting();
  }

  onForeground(): void {
    if (!this.active()) return;
    void this.sync();
    // A page left open for more than a session's length comes back to a new session, and that is an opening.
    this.followSession();
    if (this.fresh) this.onEvent({ type: 'app_open' });
    this.showWaiting();
  }

  /** A delay does not outlive the visit: what was counting down, or had just finished, is dropped. */
  onBackground(): void {
    if (this.delayed) this.cancel(this.delayed.timer);
    this.delayed = null;
    if (this.waiting?.only !== undefined) this.waiting = null;
  }

  /** The event batch response carries two timestamps; a change in either means the campaigns moved. */
  onBatchResponse(body: unknown): void {
    if (!this.active() || !isObject(body) || !isObject(body.in_app)) return;
    const { campaigns_changed_at: campaigns, user_changed_at: user } = body.in_app;
    const moved =
      (typeof campaigns === 'string' && campaigns !== this.synced.campaignsChangedAt) ||
      (typeof user === 'string' && user !== this.synced.userChangedAt);
    if (!moved || this.syncTimer !== null) return;
    // Spread out, so launching a campaign does not bring every open tab to the server at once.
    const delay = Math.floor((this.deps.random ?? Math.random)() * JITTER);
    this.syncTimer = this.timer(() => {
      this.syncTimer = null;
      void this.sync();
    }, delay);
  }

  onEvent(event: EngineEvent): void {
    // Remembered even before in-app runs, so a message never opens over a screen it was told to avoid.
    if (event.type === 'screen_view') this.screen = event.name?.toLowerCase() ?? null;
    if (!this.active()) {
      if (event.type === 'screen_view' && !this.running) this.landing = event;
      return;
    }
    if (this.now() - this.lastSyncAttempt > SYNC_EVERY) void this.sync();

    // A tab left open and idle comes back to a new session with its first event, and that is an opening.
    this.followSession();
    if (this.fresh && event.type !== 'app_open') this.onEvent({ type: 'app_open' });

    if (event.type === 'app_open') {
      // Once per session, as on every platform: a page load within a session is not an opening.
      if (!this.fresh) return;
      this.fresh = false;
      if (this.syncing) return this.hold(event);
    }
    if (this.holdAll && this.syncing) return this.hold(event);
    this.handle(event);
    if (event.type === 'screen_view') this.showWaiting();
  }

  // MARK: Deciding

  private handle(event: EngineEvent): void {
    this.reload(false);
    this.followSession();
    const engine = this.engine;
    if (!engine) return;
    engine.update(this.device());
    const decision = this.guarded(() => engine.peek(event, this.now()));
    this.persist();
    if (!decision) return;
    this.explain(event, decision);
    if (decision.show === null) return;

    const priority = engine.campaign(decision.show)?.priority ?? 0;
    if ((decision.delay ?? 0) > 0) {
      this.delay(event, decision.show, priority, decision.delay ?? 0);
      return;
    }
    if (this.blocked()) {
      if (!this.waiting || priority > this.waiting.priority) this.waiting = { event, priority };
      return;
    }
    this.show(engine, decision, event);
  }

  /** Holds one message until its delay has passed; then it is decided again, as a waiting one is. */
  private delay(event: EngineEvent, only: string, priority: number, seconds: number): void {
    if (this.delayed && this.delayed.priority >= priority) return;
    if (this.delayed) this.cancel(this.delayed.timer);
    const timer = this.timer(() => {
      this.delayed = null;
      if (!this.active()) return;
      if (!this.waiting || priority > this.waiting.priority) this.waiting = { event, priority, only };
      this.showWaiting();
    }, seconds * 1000);
    this.delayed = { timer, priority };
  }

  /** Whenever the screen may have become free: what waited first, then a test sent from the dashboard. */
  private showWaiting(): void {
    this.showHeld();
    this.showTest();
  }

  private showHeld(): void {
    if (!this.active() || this.blocked() || !this.waiting) return;
    const { event, only } = this.waiting;
    this.waiting = null;
    this.reload(false);
    const engine = this.engine;
    if (!engine) return;
    engine.update(this.device());
    const decision = this.guarded(() => engine.recheck(event, this.now()));
    if (!decision) return;
    this.explain(event, decision);
    // A delayed message shows only if it still wins; whatever beat it had its own chance at the trigger.
    if (only !== undefined && decision.show !== only) return;
    if (decision.show === null) return;
    // What waited may now be another campaign; if that one has a delay, it waits it out like any other.
    if (only === undefined && (decision.delay ?? 0) > 0) {
      this.delay(event, decision.show, engine.campaign(decision.show)?.priority ?? 0, decision.delay ?? 0);
      return;
    }
    this.show(engine, decision, event);
  }

  private show(engine: Engine, decision: Decision, event: EngineEvent): void {
    const id = decision.show;
    const campaign = id === null ? null : engine.campaign(id);
    if (id === null || !campaign) return;
    if (this.vetoed(id)) return;
    // The host's answer may have stopped the SDK, paused it or hidden the page.
    if (!this.active() || this.blocked()) return;

    this.showing = id;
    const revision = campaign.raw.revision;
    const base = { campaign_id: id, revision: typeof revision === 'number' ? revision : 1 };
    // Counted only once it is on the page, so a message nobody saw uses up no limit and reports no view.
    let seen = false;
    const drawn = (): void => {
      seen = true;
      // A sync or another tab may have replaced the engine while an html page loaded.
      this.reload(false);
      const view = this.engine?.record(id, this.now()) ?? engine.record(id, this.now());
      if (view === null) return;
      this.persist();
      this.deps.report(view, 'in_app_viewed', { ...base, template: campaign.template });
      this.call(() => this.callbacks.onShown?.(id));
    };

    const { question } = campaign.content;
    let answer: Record<string, unknown> | null = null;
    const answered: Answered = (value) => {
      if (!question) return;
      // A sync or another tab may have replaced the engine since the message was drawn.
      this.reload(false);
      this.engine?.answer(id);
      this.persist();
      answer = answerOf(question, value);
      this.deps.report(this.deps.newId(), 'in_app_answered', { ...base, ...answer });
      this.handle({ type: 'event', name: 'in_app_answered', properties: { campaign_id: id, ...answer } });
    };
    // Reported at Send, not when the message closes: a reload during the thanks must not lose it.
    const commented: Commented = (comment) => {
      if (answer) this.deps.report(this.deps.newId(), 'in_app_commented', { ...base, ...answer, comment });
    };

    // At most one click a view: an html page's first track or open.
    let clicked = false;
    const click = (buttonId: string | null, action: string, payload: Record<string, unknown> | null): void => {
      if (clicked) return;
      clicked = true;
      // A tap on the message itself has no button, so it names none.
      const button = buttonId === null ? {} : { button_id: buttonId };
      this.deps.report(this.deps.newId(), 'in_app_clicked', { ...base, ...button, action });
      this.call(() => this.callbacks.onClicked?.(id, buttonId, payload));
    };

    const rendered: Rendered = {
      title: decision.title ?? null,
      message: decision.message ?? null,
      buttons: decision.buttons ?? [],
      urls: decision.urls ?? [],
    };
    let withdrawn = false;
    const discards = this.discards;
    const page = isHtml(campaign.raw)
      ? this.page(
          String(campaign.raw.content.html),
          event,
          {
            track: (name, properties) => {
              click(null, 'track', null);
              this.deps.track?.(name, { ...properties, campaign_id: id });
            },
            setAttribute: (key, value) => this.deps.setAttribute?.(key, value),
          },
          () => {
            // A sync may have removed the campaign while the page loaded.
            withdrawn = !this.eligible() || (this.reload(false), this.engine?.campaign(id) == null);
            return !withdrawn;
          },
        )
      : undefined;
    const generation = this.generation;
    void this.present({ campaign, rendered, page }, drawn, answered, commented)
      .catch((error: unknown): Outcome => {
        this.deps.logger.reportError(GrovsError.inAppDisplayFailed, `In-app message ${id} could not be drawn: ${String(error)}`);
        return { kind: 'dismissed', reason: 'failed' };
      })
      .then((outcome) => {
        this.showing = null;
        if (generation !== this.generation) return;
        const failed = outcome.kind === 'dismissed' && outcome.reason === 'failed';
        // Withdrawn at reveal: it waits, as a blocked message does.
        if (withdrawn && discards === this.discards && (!this.waiting || campaign.priority > this.waiting.priority)) this.waiting = { event, priority: campaign.priority };
        // A missing field fails only this show: the attribute may be set later.
        if (failed && page && !withdrawn && !('missing' in outcome && outcome.missing)) this.failedHtml.add(id);
        // A page closed before it was revealed was never seen: nothing to report.
        if (!failed && (seen || outcome.kind !== 'dismissed')) this.settle(campaign, base, outcome, click);
        // A link takes the person away; what waits is shown when they are back, not as they leave.
        if (!(outcome.kind === 'clicked' && outcome.action.type === 'open_url')) this.showWaiting();
      });
  }

  // MARK: Test messages

  /** Each test has its own ten tries. */
  private nextTest(): void {
    this.tests = this.tests.slice(1);
    this.testTries = 0;
  }

  private takeTests(body: unknown): void {
    if (!isObject(body) || !Array.isArray(body.test_messages) || body.test_messages.length === 0) return;
    // Added to what still waits: the server hands each test over once, so replacing would lose one.
    this.tests = [...this.tests, ...(body.test_messages as unknown[])];
    this.images.preload(this.tests);
    this.showTest();
  }

  /**
   * No trigger, condition or limit applies, no view is counted and nothing is reported. It still waits for a
   * free screen, a visible page and a host that has not paused messages, and is tried again when they change.
   */
  private showTest(): void {
    const raw = this.tests[0];
    if (raw === undefined || !this.active() || this.blocked()) return;
    if (!this.images.ready(raw)) {
      if (this.testTimer !== null) return;
      this.testTries += 1;
      if (this.testTries > TEST_TRIES) {
        this.deps.logger.warn('In-app test message dropped: its pictures did not load');
        this.nextTest();
        this.showTest();
        return;
      }
      this.images.preload([raw]);
      this.testTimer = this.timer(() => {
        this.testTimer = null;
        this.showTest();
      }, 1000);
      return;
    }
    this.nextTest();
    const campaign = readCampaign(raw);
    const filled = campaign ? render(campaign, { type: 'app_open' }, this.device().user) : null;
    if (!campaign || !filled || !('rendered' in filled)) {
      this.deps.logger.warn('In-app test message cannot be shown by this SDK');
      return;
    }
    this.showing = campaign.id;
    const generation = this.generation;
    const nothing = (): void => undefined;
    const log = (call: string): void => this.deps.logger.info(`In-app test message: ${call}, not sent`);
    const page = isHtml(raw)
      ? this.page(String(raw.content.html), { type: 'app_open' }, {
          track: (name) => log(`track ${name}`),
          setAttribute: (key) => log(`setAttribute ${key}`),
        })
      : undefined;
    void this.present({ campaign, rendered: filled.rendered, page }, nothing, nothing, nothing)
      .catch((error: unknown) => this.deps.logger.warn(`In-app test message could not be drawn: ${String(error)}`))
      .then(() => {
        this.showing = null;
        if (generation !== this.generation) return;
        this.showWaiting();
      });
  }

  private page(body: string, event: EngineEvent, actions: PageActions, eligible = () => this.eligible()): Page {
    return { body, user: this.device().user, event: event.properties ?? {}, actions, eligible };
  }

  private present(presentation: Presentation, drawn: () => void, answered: Answered, commented: Commented): Promise<Outcome> {
    try {
      return this.deps.presenter.present(presentation, drawn, answered, commented);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private settle(
    campaign: Campaign,
    base: Record<string, unknown>,
    outcome: Outcome,
    click: (buttonId: string | null, action: string, payload: Record<string, unknown> | null) => void,
  ): void {
    const { id } = campaign;
    if (outcome.kind === 'answered') {
      // The answer and the comment were reported as they were given; only the host is told here.
      this.call(() => this.callbacks.onAnswered?.(id, outcome.value, outcome.comment));
      return;
    }
    if (outcome.kind === 'clicked') return click(outcome.buttonId, outcome.action.type, outcome.action.payload ?? null);
    this.deps.report(this.deps.newId(), 'in_app_dismissed', { ...base, reason: outcome.reason });
    this.call(() => this.callbacks.onDismissed?.(id, outcome.reason));
  }

  private vetoed(id: string): boolean {
    const ask = this.callbacks.beforeShow;
    if (!ask) return false;
    try {
      return ask(id) === false;
    } catch (error) {
      // A throwing callback is the host's bug; it must not decide what users see.
      this.deps.logger.warn(`beforeShow threw; showing ${id}: ${String(error)}`);
      return false;
    }
  }

  private blocked(): boolean {
    // A page that swapped its body took the message with it; closing it frees the screen for the next.
    if (this.showing !== null && this.deps.presenter.lost?.()) this.deps.presenter.dismiss();
    return this.showing !== null || !this.eligible();
  }

  /** What show() checks besides a free screen; asked again as an html page is revealed. */
  private eligible(): boolean {
    return this.active() && !this.paused && this.deps.isVisible() && !(this.screen !== null && this.excluded.has(this.screen));
  }

  /** What the visit opened with waits for the sync that start() began, so a campaign paused overnight does not show. */
  private hold(event: EngineEvent): void {
    if (this.held) {
      this.held.events.push(event);
      return;
    }
    const release = (): void => {
      const held = this.held;
      if (!held) return;
      this.cancel(held.timer);
      this.held = null;
      this.holdAll = false;
      if (!this.active()) return;
      // The opening first, then the screen it opened on.
      const order = [...held.events].sort((a, b) => Number(b.type === 'app_open') - Number(a.type === 'app_open'));
      for (const each of order) this.handle(each);
      this.showWaiting();
    };
    this.held = { timer: this.timer(release, OPEN_WAIT), events: [event] };
    void this.syncing?.then(release);
  }

  // MARK: Syncing

  private sync(): Promise<void> {
    if (!this.active()) return Promise.resolve();
    if (this.syncing) return this.syncing;
    this.lastSyncAttempt = this.now();
    this.keepSyncing();
    const generation = this.generation;
    const body = {
      campaigns_changed_at: this.synced.campaignsChangedAt,
      user_changed_at: this.synced.userChangedAt,
      format: FORMAT,
      sdk_version: this.deps.sdkVersion,
    };
    const sent = this.deps.clock.now();
    const request = this.deps
      .sync(body)
      .then((result) => {
        if (generation !== this.generation || !result.ok) return;
        this.apply(result.body, sent, this.deps.clock.now());
        this.takeTests(result.body);
      })
      .catch((error: unknown) => {
        this.deps.logger.warn(`In-app sync failed: ${String(error)}`);
      })
      .then(() => {
        if (this.syncing !== request) return;
        this.syncing = null;
        this.holdAll = false;
      });
    this.syncing = request;
    return request;
  }

  /** While the page is in use a sync is never more than fifteen minutes away, events or not. */
  private keepSyncing(): void {
    if (this.periodic !== null) this.cancel(this.periodic);
    this.periodic = this.timer(() => {
      this.periodic = null;
      if (this.deps.isVisible()) void this.sync();
    }, SYNC_EVERY);
  }

  private apply(body: unknown, sent: number, received: number): void {
    if (!isObject(body)) return;
    const serverTime = readTimestamp(body.server_time);
    if (serverTime === null) return;
    // Half the round trip is the best estimate of when the server read its clock.
    this.reload(false);
    this.synced.clockOffset = Math.round(serverTime - (sent + received) / 2);

    if (body.unchanged !== true) {
      if (!Array.isArray(body.campaigns)) return;
      this.synced.campaigns = body.campaigns;
      this.synced.globalCaps = capsOf(body.global_caps);
      this.synced.firstSeenAt = typeof body.first_seen_at === 'string' ? body.first_seen_at : null;
      const stamp = body.campaigns_changed_at;
      if (typeof stamp === 'string' || stamp === null) this.synced.campaignsChangedAt = stamp;
      if (typeof body.user_changed_at === 'string') this.synced.userChangedAt = body.user_changed_at;
      if (this.engine) this.kept.state = this.engine.state();
      // New campaigns or pages: a failed one gets another chance.
      this.failedHtml.clear();
      this.engine = this.build();
      this.reportUnsupported();
    }
    // After every sync, so a picture that failed to load is tried again.
    this.images.preload(this.synced.campaigns);
    saveSynced(this.deps.storage, this.synced);
    this.engine?.markSynced(serverTime);
    this.persist(true);
  }

  // MARK: State

  /** Another tab may have shown a message since; its views must count here too. Only the small record is read. */
  private reload(first: boolean): void {
    if (first) this.synced = loadSynced(this.deps.storage) ?? emptySynced();
    // What is stored is older than memory until a write succeeds again.
    if (!first && this.unsaved && this.engine) return;
    const found = loadKept(this.deps.storage);
    if (!first && this.engine && (found?.raw ?? null) === this.raw) return;
    if (found) {
      this.kept = found.kept;
      this.raw = found.raw;
    }
    if (first) this.forgetIfOld();
    this.engine = this.build();
    if (first) {
      this.reportUnsupported();
      this.images.preload(this.synced.campaigns);
    }
  }

  /** Fourteen days without a sync: the campaigns are too old to trust. Views stay, the limits need them. */
  private forgetIfOld(): void {
    const last = this.kept.state.syncedAt;
    if (last <= 0 || this.now() - last <= FORGET_AFTER || this.synced.campaigns.length === 0) return;
    this.synced = { ...this.synced, campaigns: [], campaignsChangedAt: null, userChangedAt: null };
    saveSynced(this.deps.storage, this.synced);
  }

  /** Once per revision, so a campaign this SDK cannot show is noticed without filling the log. */
  private reportUnsupported(): void {
    for (const { id, revision } of this.engine?.unsupported() ?? []) {
      const key = `${id}:${revision}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      this.deps.logger.warn(`In-app campaign ${id}, revision ${revision}, is not supported by this SDK and is skipped`);
    }
  }

  /** Read before every decision: a name changed since the sync must show at once. */
  private device(): Device {
    const seen = this.synced.firstSeenAt;
    return { ...this.deps.device(), firstSeenAt: seen === null ? null : readTimestamp(seen) };
  }

  private build(): Engine {
    return new Engine({
      device: this.device(),
      campaigns: this.synced.campaigns,
      globalCaps: this.synced.globalCaps,
      syncedAt: this.kept.state.syncedAt,
      notReady: () => this.notReady(),
      newViewId: this.deps.newId,
      state: this.kept.state,
    });
  }

  /** Session caps follow the SDK's session, so they hold across tabs and reloads within one. */
  private followSession(): void {
    const current = this.deps.sessionId();
    if (current === this.kept.sessionId) return;
    this.fresh = true;
    this.kept.sessionId = current;
    this.engine?.startSession();
    this.persist(true);
  }

  private notReady(): string[] {
    const out: string[] = [];
    for (const campaign of this.synced.campaigns) {
      if (isObject(campaign) && typeof campaign.id === 'string' && !this.images.ready(campaign)) out.push(campaign.id);
    }
    return [...out, ...this.failedHtml];
  }

  private persist(force = false): void {
    if (!this.engine) return;
    this.kept.state = this.engine.state();
    const state = JSON.stringify(this.kept.state);
    if (!force && state === this.lastState) return;
    this.lastState = state;
    const written = saveKept(this.deps.storage, this.kept);
    this.unsaved = written === null;
    if (written !== null) this.raw = written;
  }

  private lastState: string | null = null;

  // MARK: Helpers

  private active(): boolean {
    return this.running && this.deps.canRun();
  }

  private now(): number {
    return this.deps.clock.now() + this.synced.clockOffset;
  }

  private timer(run: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((fn, delay) => setTimeout(fn, delay)))(run, ms);
  }

  private cancel(handle: unknown): void {
    (this.deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(handle);
  }

  private cancelTimers(): void {
    if (this.syncTimer !== null) this.cancel(this.syncTimer);
    if (this.periodic !== null) this.cancel(this.periodic);
    this.periodic = null;
    if (this.testTimer !== null) this.cancel(this.testTimer);
    this.testTimer = null;
    if (this.held) this.cancel(this.held.timer);
    if (this.delayed) this.cancel(this.delayed.timer);
    this.syncTimer = null;
    this.held = null;
    this.delayed = null;
  }

  private guarded(decide: () => Decision): Decision | null {
    try {
      return decide();
    } catch (error) {
      this.deps.logger.warn(`In-app engine failed; nothing shown: ${String(error)}`);
      return null;
    }
  }

  private call(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.deps.logger.warn(`In-app callback threw; ignored: ${String(error)}`);
    }
  }

  private explain(event: EngineEvent, decision: Decision): void {
    if (!this.debug) return;
    const name = event.name === undefined ? event.type : `${event.type} ${event.name}`;
    const skipped = Object.keys(decision.reasons).map((id) => `${id}: ${decision.reasons[id] ?? ''}`);
    this.deps.logger.info(
      `In-app, ${name}: ${decision.show === null ? 'nothing shown' : `showing ${decision.show}`}` +
        (skipped.length > 0 ? `. Skipped ${skipped.join(', ')}` : ''),
    );
  }
}
