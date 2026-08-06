import { describe, expect, it } from 'vitest';
import { SDK_VERSION } from '../src/version';

describe('SDK_VERSION', () => {
  it('matches the iOS SDK-VERSION header value', () => {
    expect(SDK_VERSION).toBe('2.0');
  });
});
