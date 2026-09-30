import { describe, expect, it } from 'vitest';
import { loadCases, run } from './shared';

describe('shared in-app cases', () => {
  const cases = loadCases();

  it('holds the cases the backend published', () => {
    expect(cases.length).toBeGreaterThanOrEqual(66);
  });

  for (const kase of cases) {
    it(kase.name, () => {
      expect(run(kase)).toBeNull();
    });
  }
});
