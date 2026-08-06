/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

describe('SSR safety', () => {
  it('imports without a window present', async () => {
    expect(typeof window).toBe('undefined');
    const mod = await import('../src/index');
    expect(mod).toBeDefined();
  });
});
