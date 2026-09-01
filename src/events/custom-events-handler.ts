import { ENRICHMENT_LIMITS, RESERVED_EVENT_NAMES } from '../contract/event-contract';
import type { Clock } from '../core/clock';
import type { SessionManager } from '../core/session';
import { randomUUID } from '../core/uuid';
import type { Logger } from '../logging/logger';
import type { EventsHandler } from './events-handler';
import type { QueuedEvent } from './event';
import { sanitizeProperties } from './sanitize';

export const SCREEN_VIEW_EVENT = 'screen_view';

/** Matches the same-name dedup window in CustomEventsHandler on iOS. */
const SCREEN_DEDUP_MS = 1000;

// Shared across clients: a reconfigure's fresh handler re-reported the same screen (T9).
let lastScreenName: string | null = null;
let lastScreenAt = 0;

/** Test seam: the dedup outlives individual handlers. */
export function __resetScreenDedup(): void {
  lastScreenName = null;
  lastScreenAt = 0;
}

export interface CustomEventsDeps {
  events: EventsHandler;
  session: SessionManager;
  clock: Clock;
  logger: Logger;
  currentPath: () => string | null;
}

/**
 * Custom events, screen views, and global tags.
 *
 * Every event routes through EventsHandler.enqueue, which routes through
 * enrich() — no body is constructed here (spec A4/T12).
 */
export class CustomEventsHandler {
  private globalTags: string[] | null = null;
  /** Stamped onto custom events so they can be segmented by screen. */
  private currentScreenName: string | null = null;

  constructor(private readonly deps: CustomEventsDeps) {}

  track(name: string, properties?: Record<string, unknown>, tags?: string[]): void {
    const trimmed = name?.trim() ?? '';

    if (!trimmed) {
      this.deps.logger.warn('track() requires a non-empty event name; the call was ignored.');
      return;
    }

    // The backend rejects these with a 400. Failing here, with the reason,
    // beats a rejection the integrator only sees in a dashboard that stays
    // empty.
    if (RESERVED_EVENT_NAMES.has(trimmed)) {
      this.deps.logger.warn(
        `"${trimmed}" is a reserved system event name and cannot be used with track(). ` +
          'Choose a different name.',
      );
      return;
    }

    if (trimmed === SCREEN_VIEW_EVENT) {
      this.deps.logger.warn(
        'Use trackScreenView() rather than track("screen_view") so the screen name is attached.',
      );
      return;
    }

    this.enqueue(trimmed, properties, tags);
  }

  /**
   * Screen views carry screen_name in properties, and set the screen context
   * stamped onto later custom events.
   *
   * The 1-second same-name dedup stops tab switches and orientation changes
   * flooding the dashboard; it resets on session rotation, because the same
   * screen in a new session is a genuinely new view.
   */
  trackScreenView(screenName: string, properties?: Record<string, unknown>): void {
    const trimmed = screenName?.trim() ?? '';
    if (!trimmed) {
      this.deps.logger.warn('trackScreenView() requires a non-empty screen name.');
      return;
    }

    if (this.deps.session.rotateIfIdle()) this.resetDedup();

    // Set before the dedup returns, or a deduped view leaves later custom
    // events with no screen context.
    this.currentScreenName = trimmed;

    const now = this.deps.clock.now();
    if (lastScreenName === trimmed && now - lastScreenAt < SCREEN_DEDUP_MS) return;

    lastScreenName = trimmed;
    lastScreenAt = now;

    this.enqueue(SCREEN_VIEW_EVENT, { ...properties, screen_name: trimmed });
  }

  setGlobalTags(tags: string[] | null): void {
    this.globalTags = tags && tags.length > 0 ? [...tags] : null;
  }

  resetDedup(): void {
    __resetScreenDedup();
  }

  private enqueue(
    eventName: string,
    properties?: Record<string, unknown>,
    tags?: string[],
  ): void {
    const sanitized = sanitizeProperties(
      this.withScreenContext(eventName, properties),
      this.deps.logger,
    );

    const event: QueuedEvent = {
      id: randomUUID(),
      eventName,
      createdAt: this.deps.clock.now(),
      sessionId: this.deps.session.currentSessionId(),
    };

    const path = this.deps.currentPath();
    if (path) event.path = path;
    if (sanitized) event.properties = sanitized;

    const merged = this.mergeTags(tags);
    if (merged) event.tags = merged;

    this.deps.events.enqueue(event);
  }

  /** Custom events carry the most recently viewed screen, matching iOS. */
  private withScreenContext(
    eventName: string,
    properties?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (eventName === SCREEN_VIEW_EVENT) return properties;
    if (!this.currentScreenName) return properties;
    return { ...properties, screen_name: this.currentScreenName };
  }

  /**
   * Per-event tags take priority: when the combined count exceeds the cap,
   * they are kept first and global tags fill what remains. The alternative —
   * global tags crowding out the ones describing this specific event — loses
   * the more informative half.
   */
  private mergeTags(tags: string[] | undefined): string[] | undefined {
    const perEvent = tags ?? [];
    const global = this.globalTags ?? [];
    if (perEvent.length === 0 && global.length === 0) return undefined;

    const merged = [...perEvent];
    for (const tag of global) {
      if (merged.length >= ENRICHMENT_LIMITS.maxTags) break;
      if (!merged.includes(tag)) merged.push(tag);
    }
    return merged.slice(0, ENRICHMENT_LIMITS.maxTags);
  }
}
