import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Fixed origin so getPageIdentifier() has a stable value to assert against.
    environmentOptions: { jsdom: { url: 'http://localhost:3000' } },
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // index.ts is a delegating facade; contract/ is data consumed in Phase 1.
      exclude: ['src/index.ts', 'src/contract/**'],
      // Tiered rather than flat: a flat 85% can be met while leaving the
      // batching logic untested (spec Testing / Coverage gate).
      thresholds: {
        'src/core/**': { lines: 90 },
        'src/net/**': { lines: 90 },
        'src/storage/**': { lines: 90 },
        'src/links/**': { lines: 90 },
        'src/events/**': { lines: 90 },
        'src/tracking/**': { lines: 90 },
        'src/messages/**': { lines: 70 },
      },
    },
  },
});
