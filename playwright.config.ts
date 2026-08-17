import { defineConfig, devices } from '@playwright/test';

/**
 * E2E covers the seven flows jsdom cannot: real page lifecycle, real
 * keepalive, real cookies, real shadow DOM, and a real <script> tag load.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
  },
  projects: [
    // Stubbed: no backend needed, runs in verify.
    {
      name: 'chromium',
      testIgnore: /live\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Live: real backend, opt-in via GROVS_LIVE_API_KEY. Skips itself without
    // one, so verify stays green for anyone who has not set it.
    {
      name: 'live',
      testMatch: /live\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174/demo/',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
