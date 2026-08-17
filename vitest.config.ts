import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Fixed origin so getPageIdentifier() has a stable value to assert against.
    environmentOptions: { jsdom: { url: 'http://localhost:3000' } },
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // contract/ is declarative data. index.ts is included: it is not purely
      // delegating — showMessagesList and displayAutomaticMessages reach the
      // DOM surface directly, which is how they once routed around the
      // client's enabled guard with no test to notice.
      exclude: ['src/contract/**'],
      // Tiered rather than flat: a flat 85% can be met while leaving the
      // batching logic untested (spec Testing / Coverage gate).
      thresholds: {
        'src/core/**': { lines: 90 },
        'src/net/**': { lines: 90 },
        'src/storage/**': { lines: 90 },
        'src/links/**': { lines: 90 },
        'src/events/**': { lines: 90 },
        'src/tracking/**': { lines: 90 },
        'src/compat/**': { lines: 85 },
        'src/logging/**': { lines: 90 },
        'src/messages/**': { lines: 70 },
        // A ratchet, not a target: the facade is mostly delegation, but it
        // once routed around the client's enabled guard, so it must not slip
        // further than it already has.
        'src/index.ts': { lines: 50 },
      },
    },
  },
});
