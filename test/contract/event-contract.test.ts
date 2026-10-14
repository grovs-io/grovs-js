import { describe, expect, it } from 'vitest';
import {
  ENRICHMENT_KEYS,
  ENRICHMENT_LIMITS,
  MESSAGE_EVENT_NAMES,
  RESERVED_EVENT_NAMES,
} from '../../src/contract/event-contract';

describe('event contract', () => {
  it('matches the backend enrichment limits', () => {
    expect(ENRICHMENT_LIMITS.maxStringLength).toBe(255);
    expect(ENRICHMENT_LIMITS.maxTags).toBe(20);
    expect(ENRICHMENT_LIMITS.maxPropertiesBytes).toBe(8192);
  });

  it('mirrors Grovs::Events::RESERVED_EVENT_NAMES: the system event types and push_open', () => {
    expect([...RESERVED_EVENT_NAMES].sort()).toEqual(
      ['app_open', 'view', 'open', 'install', 'reinstall', 'time_spent', 'reactivation', 'user_referred', 'push_open'].sort(),
    );
  });

  it('mirrors Grovs::Events::MESSAGE_EVENT_NAMES, and reserves no smart banner event', () => {
    expect([...MESSAGE_EVENT_NAMES].sort()).toEqual(
      [
        'push_open',
        'in_app_viewed',
        'in_app_clicked',
        'in_app_dismissed',
        'in_app_answered',
        'in_app_commented',
        'in_app_held',
        'push_delivered',
        'push_held',
        'journey_entered',
        'journey_held',
        'journey_path',
      ].sort(),
    );
    expect([...MESSAGE_EVENT_NAMES, ...RESERVED_EVENT_NAMES].some((name) => name.startsWith('smart_banner'))).toBe(false);
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
