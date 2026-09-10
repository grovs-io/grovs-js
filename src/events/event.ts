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
  /**
   * Set once the event's attribution is settled and it may be transmitted —
   * with a path, or explicitly without one. Persisted, so a page load that
   * finds it already true knows an earlier page could have sent this event
   * and must not change its body. See EventsHandler.onPathResolved.
   */
  pathFinal?: true;
  engagementTime?: number;
  tags?: string[];
  properties?: Record<string, unknown>;
  sessionId: string;
}

export function isSystemEvent(event: QueuedEvent): boolean {
  return typeof event.event === 'string';
}
