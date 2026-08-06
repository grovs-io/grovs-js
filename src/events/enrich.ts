import type { CustomEventBody, EventBody, SystemEventBody } from '../contract/event-contract';
import { ENRICHMENT_LIMITS } from '../contract/event-contract';
import type { QueuedEvent } from './event';
import { isSystemEvent } from './event';

/**
 * The single point where a queued event becomes a wire body.
 *
 * Spec A4/T12: three handlers must attach an identical enrichment set forever.
 * A shared function makes an omission require deliberately bypassing this
 * path rather than merely forgetting a field — three independent handlers
 * that must agree is the same structural gap that let JS and iOS drift apart
 * in the first place. No handler constructs a body directly.
 */
export function enrich(event: QueuedEvent): EventBody {
  if (!isSystemEvent(event) && !event.eventName) {
    // Rails reads '' as absent and answers "missing event or event_name",
    // a permanent rejection. Better to fail here than to send a body the
    // backend is guaranteed to refuse.
    throw new Error('Grovs — a custom event requires a non-empty event_name.');
  }

  const base = {
    event_id: event.id,
    session_id: truncate(event.sessionId),
    created_at: new Date(event.createdAt).toISOString(),
  };

  const optional: Partial<EventBody> = {};
  if (event.path) optional.path = event.path;
  if (typeof event.engagementTime === 'number') optional.engagement_time = event.engagementTime;
  const tags = normaliseTags(event.tags);
  if (tags) optional.tags = tags;

  if (isSystemEvent(event)) {
    return { ...base, ...optional, event: event.event } as SystemEventBody;
  }

  const custom: CustomEventBody = {
    ...base,
    ...optional,
    event_name: truncate(event.eventName ?? ''),
  };
  if (event.properties) custom.properties = event.properties;
  return custom;
}

/**
 * The backend truncates event_name, session_id and each tag to 255 characters
 * (Grovs::Enrichment::MAX_STRING_LENGTH). Applying it client-side means the
 * value stored is the value the integrator can predict, rather than one
 * silently shortened somewhere they cannot see.
 */
function truncate(value: string): string {
  return value.length > ENRICHMENT_LIMITS.maxStringLength
    ? value.slice(0, ENRICHMENT_LIMITS.maxStringLength)
    : value;
}

function normaliseTags(tags: string[] | undefined): string[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  return tags.slice(0, ENRICHMENT_LIMITS.maxTags).map((tag) => truncate(String(tag)));
}
