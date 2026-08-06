import { describe, expect, it } from 'vitest';
import {
  ENRICHMENT_KEYS,
  ENRICHMENT_LIMITS,
  RESERVED_EVENT_NAMES,
} from '../../src/contract/event-contract';

describe('event contract', () => {
  it('matches the backend enrichment limits', () => {
    expect(ENRICHMENT_LIMITS.maxStringLength).toBe(255);
    expect(ENRICHMENT_LIMITS.maxTags).toBe(20);
    expect(ENRICHMENT_LIMITS.maxPropertiesBytes).toBe(8192);
  });

  it('reserves the eight system event names the backend rejects', () => {
    for (const name of [
      'app_open',
      'view',
      'open',
      'install',
      'reinstall',
      'time_spent',
      'reactivation',
      'user_referred',
    ]) {
      expect(RESERVED_EVENT_NAMES.has(name)).toBe(true);
    }
    expect(RESERVED_EVENT_NAMES.size).toBe(8);
  });

  it('does not reserve screen_view, which trackScreenView uses', () => {
    expect(RESERVED_EVENT_NAMES.has('screen_view')).toBe(false);
  });

  it('carries path, not link', () => {
    expect(ENRICHMENT_KEYS).toContain('path');
    expect(ENRICHMENT_KEYS).not.toContain('link');
  });

  it('includes every key the A4 table requires', () => {
    expect([...ENRICHMENT_KEYS].sort()).toEqual(
      ['created_at', 'engagement_time', 'event_id', 'path', 'session_id', 'tags'].sort(),
    );
  });
});
