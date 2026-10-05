import type { Storage } from '../storage/storage';
import type { EngineState } from './engine';
import type { GlobalCaps } from './types';

/**
 * What the in-app engine keeps between page loads, under two keys.
 *
 * The campaigns are large and change only at a sync. The state — views and
 * counts — is small and changes with every message shown. Kept apart, showing
 * a message rewrites a few hundred bytes instead of every campaign.
 *
 * The host site shares localStorage's quota, so the campaigns are capped and
 * the lowest priority ones are left out first. The state is never dropped.
 */

export const IN_APP_KEY = 'grovs_in_app';
export const IN_APP_STATE_KEY = 'grovs_in_app_state';
const BUDGET = 500_000;
/** Views older than this cannot affect a day or week cap; lifetime caps need them, so they are kept. */
const MAX_VIEWS = 5_000;

export interface Synced {
  campaigns: unknown[];
  globalCaps: GlobalCaps;
  firstSeenAt: string | null;
  campaignsChangedAt: string | null;
  userChangedAt: string | null;
  /** Server time minus device time at the last sync, in ms. */
  clockOffset: number;
}

export interface Kept {
  /** The SDK session the engine's session caps belong to. */
  sessionId: string | null;
  state: EngineState;
}

export function emptySynced(): Synced {
  return {
    campaigns: [],
    globalCaps: { session: null, day: null },
    firstSeenAt: null,
    campaignsChangedAt: null,
    userChangedAt: null,
    clockOffset: 0,
  };
}

export function emptyKept(): Kept {
  return { sessionId: null, state: { views: [], session: [], counts: {}, syncedAt: 0 } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function priorityOf(campaign: unknown): number {
  const priority = isObject(campaign) ? campaign.priority : null;
  return typeof priority === 'number' ? priority : 0;
}

function parse(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Null for a missing or unreadable record: the caller starts empty and syncs. */
export function loadSynced(storage: Storage): Synced | null {
  const parsed = parse(storage.get(IN_APP_KEY));
  if (!parsed || !Array.isArray(parsed.campaigns)) return null;
  return { ...emptySynced(), ...parsed } as Synced;
}

export function loadKept(storage: Storage): { kept: Kept; raw: string } | null {
  const raw = storage.get(IN_APP_STATE_KEY);
  const parsed = parse(raw);
  if (raw === null || !parsed || !isObject(parsed.state)) return null;
  const { views, session, counts, answered } = parsed.state;
  if (!Array.isArray(views) || !Array.isArray(session) || !isObject(counts)) return null;
  const kept = { ...emptyKept(), ...parsed } as Kept;
  // Anything but a list of ids would make every decision throw, or a string match by substring.
  kept.state.answered = Array.isArray(answered) && answered.every((id) => typeof id === 'string') ? (answered as string[]) : [];
  return { kept, raw };
}

/** html campaigns stay in memory; without a stamp the next page load's sync sends them again. */
export function saveSynced(storage: Storage, synced: Synced): boolean {
  const kept = synced.campaigns.filter((campaign) => !isHtml(campaign)).sort((a, b) => priorityOf(b) - priorityOf(a));
  for (;;) {
    // Any campaign left out, html or dropped for space, must come back with the next sync.
    const stamp = kept.length < synced.campaigns.length ? null : synced.campaignsChangedAt;
    const raw = JSON.stringify({ ...synced, campaigns: kept, campaignsChangedAt: stamp });
    if (raw.length <= BUDGET || kept.length === 0) return storage.set(IN_APP_KEY, raw);
    kept.pop();
  }
}

/** Returns what was written, or null when the store refused it. */
export function saveKept(storage: Storage, kept: Kept): string | null {
  const views = kept.state.views.slice(-MAX_VIEWS);
  const raw = JSON.stringify({ ...kept, state: { ...kept.state, views } });
  return storage.set(IN_APP_STATE_KEY, raw) ? raw : null;
}

export function clear(storage: Storage): void {
  storage.remove(IN_APP_KEY);
  storage.remove(IN_APP_STATE_KEY);
}

export function isHtml(campaign: unknown): campaign is Record<string, unknown> & { content: Record<string, unknown> } {
  return isObject(campaign) && campaign.template === 'html' && isObject(campaign.content);
}
