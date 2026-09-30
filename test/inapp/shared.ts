import { readFileSync } from 'node:fs';
import { readTimestamp } from '../../src/inapp/definition';
import { Engine } from '../../src/inapp/engine';
import type { Decision, Device, EngineEvent, GlobalCaps, PushPermission } from '../../src/inapp/types';

/**
 * Loads test/in-app-shared/cases.json, a copy of the backend's contract, and
 * runs a case through an engine. See README.md beside it for the format.
 */

export const SHARED = 'test/in-app-shared';

type Json = Record<string, unknown>;

export interface Step {
  session_start?: boolean;
  sync?: { at: string };
  answer?: string;
  at?: string;
  event?: EngineEvent;
  expect?: Json;
}

export interface Case {
  name: string;
  offSchema: string[];
  device: Json;
  campaigns: Json[];
  steps: Step[];
  globalCaps: GlobalCaps;
  syncedAt: string;
  notReady: string[];
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Objects merge key by key; arrays and scalars, null included, replace. */
export function merge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const key of Object.keys(over)) {
    const a = base[key];
    const b = over[key];
    out[key] = isObject(a) && isObject(b) ? merge(a, b) : b;
  }
  return out;
}

export function readJson(name: string): Json {
  return JSON.parse(readFileSync(`${SHARED}/${name}`, 'utf8')) as Json;
}

export function loadCases(): Case[] {
  const file = readJson('cases.json');
  const baseCampaign = file.base_campaign as Json;
  const baseDevice = file.base_device as Json;
  const baseCase = file.base_case as Json;
  return (file.cases as Json[]).map((raw) => {
    const top = merge(baseCase, pick(raw, ['global_caps', 'synced_at', 'not_ready']));
    return {
      name: raw.name as string,
      offSchema: (raw.off_schema as string[] | undefined) ?? [],
      device: merge(baseDevice, (raw.device as Json | undefined) ?? {}),
      campaigns: (raw.campaigns as Json[]).map((campaign) => merge(baseCampaign, campaign)),
      steps: raw.steps as Step[],
      globalCaps: top.global_caps as GlobalCaps,
      syncedAt: top.synced_at as string,
      notReady: top.not_ready as string[],
    };
  });
}

function pick(source: Json, keys: string[]): Json {
  const out: Json = {};
  for (const key of keys) if (key in source) out[key] = source[key];
  return out;
}

function time(value: string): number {
  const at = readTimestamp(value);
  if (at === null) throw new Error(`bad timestamp in cases.json: ${value}`);
  return at;
}

export function deviceOf(raw: Json): Device {
  const seen = raw.first_seen_at;
  return {
    platform: String(raw.platform ?? ''),
    appVersion: String(raw.app_version ?? ''),
    osVersion: String(raw.os_version ?? ''),
    language: String(raw.language ?? ''),
    firstSeenAt: typeof seen === 'string' ? readTimestamp(seen) : null,
    utcOffsetMinutes: Number(raw.utc_offset_minutes ?? 0),
    user: (raw.user as Json | undefined) ?? {},
    pushPermission: (raw.push_permission as PushPermission | undefined) ?? 'not_asked',
    unsupportedTemplates: (raw.unsupported_templates as string[] | undefined) ?? [],
    unsupportedActions: (raw.unsupported_actions as string[] | undefined) ?? [],
  };
}

export type EngineClass = new (options: ConstructorParameters<typeof Engine>[0]) => Engine;

export function build(kase: Case, campaigns: readonly unknown[] = kase.campaigns, engine: EngineClass = Engine): Engine {
  let next = 0;
  return new engine({
    device: deviceOf(kase.device),
    campaigns,
    globalCaps: kase.globalCaps,
    syncedAt: time(kase.syncedAt),
    notReady: () => kase.notReady,
    newViewId: () => {
      next += 1;
      return `d${next}`;
    },
  });
}

/** Runs every step; returns the first mismatch as text, or null when the case passes. */
export function run(kase: Case, engine: Engine = build(kase)): string | null {
  for (const [index, step] of kase.steps.entries()) {
    if (step.session_start) {
      engine.startSession();
      continue;
    }
    if (step.sync) {
      engine.markSynced(time(step.sync.at));
      continue;
    }
    if (step.answer !== undefined) {
      engine.answer(step.answer);
      continue;
    }
    if (!step.event || !step.at || !step.expect) throw new Error(`unreadable step ${index + 1} in "${kase.name}"`);
    const decision = engine.track(step.event, time(step.at)) as Decision & Json;
    for (const key of Object.keys(step.expect)) {
      const wanted = JSON.stringify(sorted(step.expect[key]));
      const got = JSON.stringify(sorted(decision[key] ?? null));
      if (wanted !== got) return `step ${index + 1}, ${key}: wanted ${wanted}, got ${got}`;
    }
  }
  return null;
}

/** Key order is not part of the contract, so objects are compared with their keys sorted. */
function sorted(value: unknown): unknown {
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const key of Object.keys(value).sort()) out[key] = sorted(value[key]);
  return out;
}
