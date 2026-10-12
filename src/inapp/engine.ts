import { readCampaign } from './definition';
import { render } from './personalize';
import { dayOf, inSchedule, weekOf } from './schedule';
import { compare, compareVersions } from './values';
import type {
  Campaign,
  Condition,
  Decision,
  Device,
  EngineEvent,
  GlobalCaps,
  Reason,
  Rendered,
  Trigger,
} from './types';

/**
 * Decides which campaign, if any, an event shows.
 *
 * Pure logic: no DOM, no network, no storage, no clock of its own. The
 * caller passes the time and owns persistence through `state()`. That is what
 * lets the shared cases run against it directly, and what keeps every
 * platform's engine comparable line by line with the backend's reference.
 *
 * The order of checks in `skipReason` is part of the contract; see
 * test/in-app-shared/README.md.
 */

const STALE_AFTER = 48 * 3_600_000;

export interface View {
  id: string;
  campaign: string;
  at: number;
  /** False for a campaign that ignores the global caps. */
  global: boolean;
}

export interface EngineState {
  views: View[];
  /** Ids of the views recorded in the current session. */
  session: string[];
  counts: Record<string, number>;
  syncedAt: number;
  /** Ids of the campaigns whose question was answered. Absent in state stored before questions existed. */
  answered?: string[];
}

export interface EngineOptions {
  device: Device;
  /** Definitions as received. Each is read once; one the engine cannot read is unsupported. */
  campaigns: readonly unknown[];
  globalCaps: GlobalCaps;
  syncedAt: number;
  /** Ids of campaigns whose images are not on the device yet. */
  notReady?: () => readonly string[];
  newViewId: () => string;
  state?: EngineState;
}

interface Entry {
  id: string;
  campaign: Campaign | null;
  revision: number;
}

function entriesOf(campaigns: readonly unknown[]): Entry[] {
  const out: Entry[] = [];
  for (const raw of campaigns) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const { id, revision } = raw as { id?: unknown; revision?: unknown };
    out.push({
      id: typeof id === 'string' ? id : '',
      campaign: readCampaign(raw),
      revision: typeof revision === 'number' ? revision : 1,
    });
  }
  return out;
}

export class Engine {
  private device: Device;
  private readonly entries: Entry[];
  private readonly globalCaps: GlobalCaps;
  private readonly notReady: () => readonly string[];
  private readonly newViewId: () => string;
  private readonly counted: Set<string>;
  private views: View[];
  private session: string[];
  private counts: Record<string, number>;
  private syncedAt: number;
  private answered: string[];

  constructor(options: EngineOptions) {
    this.device = options.device;
    this.entries = entriesOf(options.campaigns);
    this.globalCaps = options.globalCaps;
    this.notReady = options.notReady ?? (() => []);
    this.newViewId = options.newViewId;
    this.views = options.state?.views ?? [];
    this.session = options.state?.session ?? [];
    this.counts = options.state?.counts ?? {};
    this.syncedAt = options.state?.syncedAt ?? options.syncedAt;
    this.answered = options.state?.answered ?? [];
    this.counted = new Set();
    for (const { campaign } of this.entries) {
      if (!campaign) continue;
      if (!this.supported(campaign)) continue;
      for (const condition of campaign.conditions) {
        if (condition.type === 'event_count') this.counted.add(condition.name);
      }
    }
  }

  /** The user changes between syncs; which campaigns are supported does not. */
  update(device: Device): void {
    this.device = device;
  }

  /** Campaigns this device cannot read or cannot show. */
  unsupported(): { id: string; revision: number }[] {
    return this.entries
      .filter(({ campaign }) => !campaign || !this.supported(campaign))
      .map(({ id, revision }) => ({ id, revision }));
  }

  /** What to persist so caps and counts survive a reload. */
  state(): EngineState {
    return {
      views: this.views,
      session: this.session,
      counts: this.counts,
      syncedAt: this.syncedAt,
      answered: this.answered,
    };
  }

  startSession(): void {
    this.session = [];
  }

  /**
   * A sync restarts the 48 hour clock and changes nothing else. Every cap is counted here, from the
   * views this device recorded; the server leaves out campaigns a person is already done with.
   */
  markSynced(at: number): void {
    this.syncedAt = at;
  }

  /** Records that the question of this campaign was answered, so it is not asked again. */
  answer(id: string): void {
    if (!this.answered.includes(id)) this.answered.push(id);
  }

  /** Counts the event, decides, and records the view: one call, as the shared cases expect. */
  track(event: EngineEvent, at: number): Decision {
    const decision = this.peek(event, at);
    if (decision.show === null) return decision;
    return { ...decision, view: this.record(decision.show, at) ?? '' };
  }

  /** Counts the event and decides, recording nothing: the caller may still be vetoed or busy. */
  peek(event: EngineEvent, at: number): Decision {
    if (event.type === 'event' && event.name !== undefined && this.counted.has(event.name)) {
      this.counts[event.name] = (this.counts[event.name] ?? 0) + 1;
    }
    return this.recheck(event, at);
  }

  /** Decides again for an event already counted, as a message that waited must. */
  recheck(event: EngineEvent, at: number): Decision {
    const reasons: Record<string, Reason> = {};
    const passing: { campaign: Campaign; rendered: Rendered }[] = [];
    for (const { id, campaign } of this.entries) {
      const outcome = campaign ? this.consider(campaign, event, at) : 'unsupported';
      if (typeof outcome === 'string') reasons[id] = outcome;
      else if (campaign) passing.push({ campaign, rendered: outcome });
    }

    passing.sort(
      (a, b) =>
        b.campaign.priority - a.campaign.priority ||
        a.campaign.createdAt - b.campaign.createdAt ||
        (a.campaign.id < b.campaign.id ? -1 : 1),
    );
    const [winner, ...rest] = passing;
    for (const { campaign } of rest) reasons[campaign.id] = 'lower_priority';
    if (!winner) return { show: null, reasons };
    return { show: winner.campaign.id, delay: winner.campaign.delaySeconds, reasons, ...winner.rendered };
  }

  /** Records a view of a campaign about to be drawn; returns the view's id, or null for an unknown campaign. */
  record(id: string, at: number): string | null {
    const campaign = this.campaign(id);
    if (!campaign) return null;
    const view: View = { id: this.newViewId(), campaign: id, at, global: !campaign.caps.ignoreGlobal };
    this.views.push(view);
    this.session.push(view.id);
    return view.id;
  }

  campaign(id: string): Campaign | null {
    return this.entries.find((entry) => entry.campaign?.id === id)?.campaign ?? null;
  }

  private consider(campaign: Campaign, event: EngineEvent, at: number): Reason | Rendered {
    const reason = this.skipReason(campaign, event, at);
    if (reason) return reason;
    const outcome = render(campaign, event, this.device.user);
    return 'reason' in outcome ? outcome.reason : outcome.rendered;
  }

  private skipReason(campaign: Campaign, event: EngineEvent, at: number): Reason | null {
    if (at - this.syncedAt > STALE_AFTER) return 'stale';
    if (!this.supported(campaign)) return 'unsupported';
    if (!campaign.triggers.some((trigger) => matches(trigger, event))) return 'no_trigger';
    if (this.notReady().includes(campaign.id)) return 'not_ready';
    if (!inSchedule(campaign.schedule, at, this.device.utcOffsetMinutes)) return 'schedule';
    if (!this.conditionsPass(campaign, at)) return 'condition';
    if (this.answered.includes(campaign.id)) return 'answered';
    return this.capReason(campaign, at);
  }

  private supported(campaign: Campaign): boolean {
    if (campaign.format !== 1 || campaign.deliveryMode !== 'device') return false;
    if (campaign.reserved) return false;
    if (this.device.unsupportedTemplates.includes(campaign.template)) return false;
    return !actionTypes(campaign).some((type) => this.device.unsupportedActions.includes(type));
  }

  private conditionsPass(campaign: Campaign, at: number): boolean {
    const asksForPush = actionTypes(campaign).includes('request_push_permission');
    if (asksForPush && this.device.pushPermission === 'granted') return false;
    // A message for one orientation waits for it, like a condition.
    if (campaign.content.orientation && campaign.content.orientation !== this.device.orientation) return false;
    return campaign.conditions.every((condition) => this.conditionPasses(condition, at));
  }

  private conditionPasses(condition: Condition, at: number): boolean {
    const { device } = this;
    switch (condition.type) {
      case 'platform':
        return compare(device.platform, condition.op, condition.value);
      case 'language':
        return compare(device.language, condition.op, condition.value);
      case 'app_version':
        return compareVersions(device.appVersion, condition.op, condition.value);
      case 'os_version':
        return compareVersions(device.osVersion, condition.op, condition.value);
      case 'user_attribute':
        return compare(own(device.user, condition.key), condition.op, condition.value);
      case 'event_count':
        return compare(this.counts[condition.name] ?? 0, condition.op, condition.value);
      case 'first_seen':
        return this.firstSeenPasses(condition.op, condition.value, at);
    }
  }

  private firstSeenPasses(op: 'before' | 'after' | 'within_days', value: number, at: number): boolean {
    const seen = this.device.firstSeenAt;
    if (seen === null) return false;
    if (op === 'before') return seen < value;
    if (op === 'after') return seen > value;
    return at - seen <= value * 86_400_000;
  }

  private capReason(campaign: Campaign, at: number): Reason | null {
    const { caps, id } = campaign;
    const mine = this.views.filter((view) => view.campaign === id);
    const inSession = this.views.filter((view) => this.session.includes(view.id));
    const today = this.day(at);
    const week = this.week(at);

    if (over(caps.session, inSession.filter((view) => view.campaign === id).length)) return 'cap_session';
    if (over(caps.day, mine.filter((view) => this.day(view.at) === today).length)) return 'cap_day';
    if (over(caps.week, mine.filter((view) => this.week(view.at) === week).length)) return 'cap_week';
    if (over(caps.lifetime, mine.length)) return 'cap_lifetime';
    if (caps.ignoreGlobal) return null;
    if (over(this.globalCaps.session, inSession.filter((view) => view.global).length)) return 'cap_global_session';

    const counted = this.views.filter((view) => view.global && this.day(view.at) === today);
    return over(this.globalCaps.day, counted.length) ? 'cap_global_day' : null;
  }

  private day(at: number): string {
    return dayOf(at, this.device.utcOffsetMinutes);
  }

  private week(at: number): string {
    return weekOf(at, this.device.utcOffsetMinutes);
  }
}

function over(limit: number | null, count: number): boolean {
  return limit !== null && count >= limit;
}

function own(source: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

function actionTypes(campaign: Campaign): string[] {
  const actions = [...campaign.content.buttons.map((button) => button.action), campaign.content.tapAction];
  return actions.flatMap((action) => (action ? [action.type] : []));
}

function matches(trigger: Trigger, event: EngineEvent): boolean {
  if (trigger.type !== event.type) return false;
  if (trigger.type === 'app_open') return true;
  if (trigger.type === 'screen_view') {
    return trigger.name === undefined || trigger.name.toLowerCase() === (event.name ?? '').toLowerCase();
  }
  if (trigger.name !== event.name) return false;
  const properties = event.properties ?? {};
  return trigger.filters.every((filter) => compare(own(properties, filter.field), filter.op, filter.value));
}
