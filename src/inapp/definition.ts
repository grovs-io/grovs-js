import { isNumber } from './values';
import type {
  Action,
  ActionType,
  Button,
  Campaign,
  Caps,
  Comparison,
  Condition,
  Content,
  Filter,
  Operator,
  Schedule,
  Template,
  Trigger,
} from './types';

/**
 * Reads a definition into the engine's model, or returns null.
 *
 * Null means the campaign is unsupported. Nothing here throws, whatever it is
 * given: a definition is data from the network, and one bad campaign must
 * never stop the others or the host page. Fields the engine does not know are
 * ignored, so a later backend can add them.
 */

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?Z$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const TEMPLATES: readonly string[] = [
  'cover',
  'interstitial',
  'half_interstitial',
  'header',
  'footer',
  'alert',
  'cover_image',
  'interstitial_image',
  'half_interstitial_image',
];
const ACTIONS: readonly string[] = ['close', 'open_url', 'key_value', 'request_push_permission', 'request_app_rating', 'open_store'];
const VALUE_OPS: readonly string[] = ['eq', 'neq', 'gt', 'lt', 'contains', 'not_contains'];
const ORDER_OPS: readonly string[] = ['eq', 'neq', 'gt', 'lt'];
const RESERVED = ['variants', 'control_group', 'conversion'] as const;

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function isPair(value: unknown, each: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length === 2 && value.every(each);
}

/** Epoch ms, or null unless the text is a real UTC calendar time in the contract's form. */
export function readTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const [, year = '', month = '', day = ''] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const real = date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
  if (!real) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function readList<T>(value: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const one = read(item);
    if (one === null) return null;
    out.push(one);
  }
  return out;
}

function readAction(value: unknown): Action | null {
  if (!isObject(value) || typeof value.type !== 'string' || !ACTIONS.includes(value.type)) return null;
  const type = value.type as ActionType;
  if (type === 'open_url') return isText(value.url) ? { type, url: value.url } : null;
  if (type === 'key_value') return isObject(value.payload) ? { type, payload: value.payload } : null;
  return { type };
}

function readButton(value: unknown): Button | null {
  if (!isObject(value) || !isText(value.id) || !isText(value.text)) return null;
  const action = readAction(value.action);
  return action ? { id: value.id, text: value.text, action } : null;
}

function readContent(value: unknown): Content | null {
  if (!isObject(value)) return null;
  const { title, message } = value;
  if (title !== null && typeof title !== 'string') return null;
  if (message !== null && typeof message !== 'string') return null;
  const buttons = readList(value.buttons, readButton);
  if (!buttons) return null;
  const { dismissible = true, tap_action: tap } = value;
  if (typeof dismissible !== 'boolean') return null;
  const tapAction = tap === null || tap === undefined ? null : readAction(tap);
  if (tapAction === null && tap !== null && tap !== undefined) return null;
  // A message nobody can dismiss must offer something to tap, or it would hold the screen for ever.
  if (!dismissible && buttons.length === 0 && tapAction === null) return null;
  return { title, message, buttons, tapAction, dismissible };
}

function readComparison(value: Raw): Comparison | null {
  const op = value.op;
  if (op === 'is_set' || op === 'is_not_set') return { op };
  if (op === 'between') return isPair(value.value, isNumber) ? { op, value: value.value } : null;
  if (typeof op === 'string' && VALUE_OPS.includes(op) && isScalar(value.value)) {
    return { op: op as Operator, value: value.value };
  }
  return null;
}

function readFilter(value: unknown): Filter | null {
  if (!isObject(value) || !isText(value.field)) return null;
  const comparison = readComparison(value);
  return comparison ? { field: value.field, ...comparison } : null;
}

function readTrigger(value: unknown): Trigger | null {
  if (!isObject(value)) return null;
  const named = 'name' in value;
  const filtered = 'filters' in value;
  switch (value.type) {
    case 'app_open':
      return named || filtered ? null : { type: 'app_open' };
    case 'screen_view':
      if (filtered) return null;
      if (!named) return { type: 'screen_view' };
      return isText(value.name) ? { type: 'screen_view', name: value.name } : null;
    case 'event': {
      if (!isText(value.name)) return null;
      const filters = filtered ? readList(value.filters, readFilter) : [];
      return filters ? { type: 'event', name: value.name, filters } : null;
    }
    default:
      return null;
  }
}

function readOrdered(value: Raw, each: (item: unknown) => boolean): Comparison | null {
  const op = value.op;
  if (op === 'between') return isPair(value.value, each) ? { op, value: value.value } : null;
  if (typeof op === 'string' && ORDER_OPS.includes(op) && each(value.value)) {
    return { op: op as Operator, value: value.value };
  }
  return null;
}

function readFirstSeen(value: Raw): Condition | null {
  if (value.op === 'before' || value.op === 'after') {
    const at = readTimestamp(value.value);
    return at === null ? null : { type: 'first_seen', op: value.op, value: at };
  }
  if (value.op === 'within_days' && isWhole(value.value) && value.value > 0) {
    return { type: 'first_seen', op: 'within_days', value: value.value };
  }
  return null;
}

function readCondition(value: unknown): Condition | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'platform':
    case 'language':
      if ((value.op !== 'eq' && value.op !== 'neq') || !isText(value.value)) return null;
      return { type: value.type, op: value.op, value: value.value };
    case 'app_version':
    case 'os_version': {
      const ordered = readOrdered(value, isText);
      return ordered ? ({ type: value.type, ...ordered } as Condition) : null;
    }
    case 'event_count': {
      if (!isText(value.name)) return null;
      const ordered = readOrdered(value, isNumber);
      return ordered ? { type: 'event_count', name: value.name, ...ordered } : null;
    }
    case 'user_attribute': {
      if (!isText(value.key)) return null;
      const comparison = readComparison(value);
      return comparison ? { type: 'user_attribute', key: value.key, ...comparison } : null;
    }
    case 'first_seen':
      return readFirstSeen(value);
    default:
      return null;
  }
}

function readCap(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return isWhole(value) && value > 0 ? value : undefined;
}

function readCaps(value: unknown): Caps | null {
  if (!isObject(value) || typeof value.ignore_global !== 'boolean') return null;
  const session = readCap(value.session);
  const day = readCap(value.day);
  const week = readCap(value.week);
  const lifetime = readCap(value.lifetime);
  if (session === undefined || day === undefined || week === undefined || lifetime === undefined) return null;
  return { session, day, week, lifetime, ignoreGlobal: value.ignore_global };
}

function readDays(value: unknown): number[] | null | undefined {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((day) => isWhole(day) && day >= 1 && day <= 7) ? (value as number[]) : undefined;
}

function readSchedule(value: unknown): Schedule | null {
  if (!isObject(value)) return null;
  const startAt = readTimestamp(value.start_at);
  if (startAt === null) return null;
  const ends = value.end_at !== null && value.end_at !== undefined;
  const endAt = ends ? readTimestamp(value.end_at) : null;
  if (ends && endAt === null) return null;
  const days = readDays(value.days);
  if (days === undefined) return null;
  const from = value.from ?? null;
  const to = value.to ?? null;
  if (from === null && to === null) return { startAt, endAt, days, from: null, to: null };
  if (typeof from !== 'string' || typeof to !== 'string' || !CLOCK.test(from) || !CLOCK.test(to)) return null;
  return { startAt, endAt, days, from, to };
}

export function readCampaign(value: unknown): Campaign | null {
  if (!isObject(value)) return null;
  const { format, id, priority, template } = value;
  if (!isWhole(format) || !isText(id) || !isWhole(priority)) return null;
  if (typeof template !== 'string' || !TEMPLATES.includes(template)) return null;
  if (!isWhole(value.delay_seconds) || value.delay_seconds < 0 || !isText(value.delivery_mode)) return null;
  const createdAt = readTimestamp(value.created_at);
  const content = readContent(value.content);
  const triggers = readList(value.triggers, readTrigger);
  const conditions = readList(value.conditions, readCondition);
  const caps = readCaps(value.caps);
  const schedule = readSchedule(value.schedule);
  if (createdAt === null || !content || !triggers || triggers.length === 0) return null;
  if (!conditions || !caps || !schedule) return null;
  return {
    format,
    id,
    createdAt,
    priority,
    template: template as Template,
    content,
    triggers,
    conditions,
    caps,
    schedule,
    delaySeconds: value.delay_seconds,
    deliveryMode: value.delivery_mode,
    reserved: RESERVED.some((field) => value[field] !== null && value[field] !== undefined),
    raw: value,
  };
}
