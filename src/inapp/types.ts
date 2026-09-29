/**
 * The shapes the in-app engine works with.
 *
 * The rules live in test/in-app-shared/README.md, a copy of the backend's
 * contract. Every engine — this one, iOS, Android — must give the same
 * answer on every case in test/in-app-shared/cases.json.
 */

export type Template =
  | 'cover'
  | 'interstitial'
  | 'half_interstitial'
  | 'header'
  | 'footer'
  | 'alert'
  | 'cover_image'
  | 'interstitial_image'
  | 'half_interstitial_image';

export type ActionType =
  | 'close'
  | 'open_url'
  | 'key_value'
  | 'request_push_permission'
  | 'request_app_rating'
  | 'open_store';

export type Scalar = string | number | boolean;

export type Operator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'lt'
  | 'between'
  | 'contains'
  | 'not_contains'
  | 'is_set'
  | 'is_not_set';

export interface Action {
  type: ActionType;
  url?: string;
  payload?: Record<string, unknown>;
}

export interface Button {
  id: string;
  text: string;
  action: Action;
}

export interface Content {
  title: string | null;
  message: string | null;
  buttons: Button[];
  tapAction: Action | null;
  /** False when only a button or the tap action may close the message. */
  dismissible: boolean;
}

export interface Comparison {
  op: Operator;
  value?: unknown;
}

export interface Filter extends Comparison {
  field: string;
}

export type Trigger =
  | { type: 'app_open' }
  | { type: 'screen_view'; name?: string }
  | { type: 'event'; name: string; filters: Filter[] };

export type Condition =
  | { type: 'platform' | 'language'; op: 'eq' | 'neq'; value: string }
  | { type: 'app_version' | 'os_version'; op: 'eq' | 'neq' | 'gt' | 'lt'; value: string }
  | { type: 'app_version' | 'os_version'; op: 'between'; value: [string, string] }
  | ({ type: 'event_count'; name: string } & Comparison)
  | ({ type: 'user_attribute'; key: string } & Comparison)
  | { type: 'first_seen'; op: 'before' | 'after'; value: number }
  | { type: 'first_seen'; op: 'within_days'; value: number };

export interface Caps {
  session: number | null;
  day: number | null;
  week: number | null;
  lifetime: number | null;
  ignoreGlobal: boolean;
}

export interface Schedule {
  startAt: number;
  endAt: number | null;
  days: number[] | null;
  from: string | null;
  to: string | null;
}

/** A definition the engine has read and found whole. Times are epoch ms. */
export interface Campaign {
  format: number;
  id: string;
  createdAt: number;
  priority: number;
  template: Template;
  content: Content;
  triggers: Trigger[];
  conditions: Condition[];
  caps: Caps;
  schedule: Schedule;
  delaySeconds: number;
  deliveryMode: string;
  /** True when variants, control_group or conversion is set: not for a format 1 engine. */
  reserved: boolean;
  /** The definition as received, for the renderer: colours, images, payloads. */
  raw: Record<string, unknown>;
}

export type PushPermission = 'granted' | 'denied' | 'not_asked';

export interface Device {
  platform: string;
  appVersion: string;
  osVersion: string;
  language: string;
  firstSeenAt: number | null;
  utcOffsetMinutes: number;
  user: Record<string, unknown>;
  pushPermission: PushPermission;
  unsupportedTemplates: readonly string[];
  unsupportedActions: readonly string[];
}

export interface EngineEvent {
  type: 'app_open' | 'screen_view' | 'event';
  name?: string;
  properties?: Record<string, unknown>;
}

export type Reason =
  | 'stale'
  | 'unsupported'
  | 'no_trigger'
  | 'not_ready'
  | 'schedule'
  | 'condition'
  | 'cap_session'
  | 'cap_day'
  | 'cap_week'
  | 'cap_lifetime'
  | 'cap_global_session'
  | 'cap_global_day'
  | 'personalization'
  | 'unsafe_link'
  | 'lower_priority';

export interface Rendered {
  title: string | null;
  message: string | null;
  buttons: string[];
  urls: string[];
}

export interface Decision extends Partial<Rendered> {
  show: string | null;
  view?: string;
  /** Seconds the display waits before it decides again and shows the campaign. */
  delay?: number;
  reasons: Record<string, Reason>;
}

export interface GlobalCaps {
  session: number | null;
  day: number | null;
}
