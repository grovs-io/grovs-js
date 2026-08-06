/**
 * Injected so handlers never call Date.now() directly (spec A2).
 *
 * Session rotation across a 45-minute background, and discarding an event
 * aged past 7 days, are both trivially testable against a fake and untestable
 * against a real clock.
 */
export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
