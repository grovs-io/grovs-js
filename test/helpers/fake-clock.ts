import type { Clock } from '../../src/core/clock';

/**
 * Deterministic clock. Makes "45 minutes backgrounded rotates the session" and
 * "an 8-day-old event is discarded" into fast unit tests instead of things
 * nobody can test against a real clock.
 */
export class FakeClock implements Clock {
  constructor(private current = 1_700_000_000_000) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }

  advanceDays(days: number): void {
    this.advance(days * 24 * 60 * 60_000);
  }
}
