/**
 * The wire contract for event payloads, written once so Phase 1's fixtures are
 * generated from it rather than transcribed from an SDK (spec T1).
 *
 * This matters because the two obvious sources are both wrong in a specific
 * way. iOS's Event.toBackend() omits `tags`, which the backend accepts and web
 * needs for campaign segmentation, so a fixture copied from iOS would encode
 * that omission as the contract. v1's JS sent `path` where iOS sends `link`.
 * The table in spec A4 is the arbiter; this file is that table as code.
 *
 * Nothing here is used until Phase 1. It lands now so the contract exists
 * before anything implements against it.
 */

/** Rejected as custom event names by Grovs::Events::RESERVED_EVENT_NAMES. */
export const RESERVED_EVENT_NAMES: ReadonlySet<string> = new Set([
  'app_open',
  'view',
  'open',
  'install',
  'reinstall',
  'time_spent',
  'reactivation',
  'user_referred',
]);

/** From Grovs::Enrichment in the backend's app_constants.rb. */
export const ENRICHMENT_LIMITS = {
  maxStringLength: 255,
  maxTags: 20,
  maxPropertiesBytes: 8192,
} as const;

/**
 * Keys attached to every event body regardless of endpoint.
 *
 * `path`, not `link`: the web SDK extracts a project-scoped path, which is
 * what data_for_device_and_path consumes. The backend resolves `path` last so
 * it wins when both are present — sending `link` from a client that only ever
 * had a path would be a lie the backend then has to disambiguate.
 */
export const ENRICHMENT_KEYS = [
  'event_id',
  'session_id',
  'created_at',
  'path',
  'engagement_time',
  'tags',
] as const;

export type SystemEventName =
  | 'app_open'
  | 'view'
  | 'open'
  | 'install'
  | 'reinstall'
  | 'time_spent'
  | 'reactivation';

interface EnrichmentFields {
  event_id: string;
  session_id: string;
  created_at: string;
  path?: string;
  engagement_time?: number;
  tags?: string[];
}

export interface SystemEventBody extends EnrichmentFields {
  event: SystemEventName;
}

export interface CustomEventBody extends EnrichmentFields {
  event_name: string;
  properties?: Record<string, unknown>;
}

export type EventBody = SystemEventBody | CustomEventBody;
