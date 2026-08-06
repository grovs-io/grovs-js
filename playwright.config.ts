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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174/demo/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
