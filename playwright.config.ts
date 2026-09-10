import { defineConfig, devices } from '@playwright/test';
import { E2E_ORIGIN, E2E_PORT } from './e2e/test-config';

/**
 * E2E covers what jsdom cannot: real page lifecycle, real keepalive, real
 * cookies, real shadow DOM, a real <script> tag load — and, in
 * delivery.spec.ts, real HTTP delivery to a server the test owns, through a
 * tab close, an offline window, a failing backend and a reload.
 *
 * All three engines run in verify. Native Safari has a separate macOS suite;
 * these WebKit tests do not reproduce Safari's multi-day ITP policy.
 */
export default defineConfig({
  testDir: './e2e',
  // One worker, no retries. The delivery suite closes and reloads real pages,
  // and a close-time keepalive request is the one thing a browser drops when
  // three engines are competing for the machine — measured as roughly one run
  // in four with parallel workers, and never serially. Retrying instead would
  // turn a real regression into a green run with a footnote. The whole suite
  // takes about 75 seconds this way.
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // No external backend needed, runs in verify.
    {
      name: 'chromium',
      testIgnore: /live\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      testIgnore: /live\.spec\.ts/,
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'firefox',
      testIgnore: /live\.spec\.ts/,
      use: { ...devices['Desktop Firefox'] },
    },
    // Live: real backend, opt-in via GROVS_LIVE_API_KEY. Excluded from verify;
    // an explicit live run fails if credentials are missing.
    {
      name: 'live',
      testMatch: /live\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Separate from the interactive demo on 5174. Reusing a long-running
    // Vite server can serve an old transformed dist bundle after a rebuild.
    command: `npx vite --port ${E2E_PORT} --strictPort`,
    url: `${E2E_ORIGIN}/demo/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
