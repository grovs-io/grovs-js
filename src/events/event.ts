import type { SystemEventName } from '../contract/event-contract';

/**
 * A queued event, before enrichment.
 *
 * `id` is minted once here, at enqueue, and never regenerated (spec A4). It is
 * persisted with the event and survives serialization, reload, engagement-time
 * mutation, and every retry — which is the whole property that makes the
 * planned server-side dedup (B11) work. An id assigned at send time would make
 * the field present and dedup useless, because the retry that needs collapsing
 * would carry a different key than the delivery it duplicates.
 */
export interface QueuedEvent {
  id: string;
  /** Present for system events; absent for custom events. */
  event?: SystemEventName;
  /** Present for custom events; absent for system events. */
  eventName?: string;
  createdAt: number;
  path?: string;
  engagementTime?: number;
  tags?: string[];
  properties?: Record<string, unknown>;
  sessionId: string;
}

export function isSystemEvent(event: QueuedEvent): boolean {
  return typeof event.event === 'string';
}
