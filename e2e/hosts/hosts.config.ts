/// <reference types="node" />
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

const HOSTS = [
  { name: 'plain', port: 4801, command: 'node e2e/hosts/plain/serve.mjs 4801' },
  { name: 'react', port: 4802, command: 'npm --prefix e2e/hosts/react run serve --silent' },
  { name: 'next', port: 4803, command: 'npm --prefix e2e/hosts/next run serve --silent' },
  { name: 'vue', port: 4804, command: 'npm --prefix e2e/hosts/vue run serve --silent' },
] as const;

const BROWSERS = {
  chromium: devices['Desktop Chrome'],
  webkit: devices['Desktop Safari'],
  firefox: devices['Desktop Firefox'],
} as const;

const pick = (value: string | undefined) => (value ? value.split(',').map((s) => s.trim()) : null);
const hostFilter = pick(process.env['HOST_APPS']);
const browserFilter = pick(process.env['HOST_BROWSERS']);
const hosts = HOSTS.filter((h) => !hostFilter || hostFilter.includes(h.name));
const browsers = (Object.keys(BROWSERS) as (keyof typeof BROWSERS)[]).filter((b) => !browserFilter || browserFilter.includes(b));
// smoke: the per-change subset; full: every case (smoke repeats a subset of them, so it is left out); rich: rich-content.spec.ts.
const SUITES: Record<string, RegExp> = {
  smoke: /(launch|smoke)\.spec\.ts/,
  full: /(launch|showing-up|navigation|interaction|rules)\.spec\.ts/,
  rich: /(launch|rich-content)\.spec\.ts/,
};
const suite = SUITES[process.env['HOST_SUITE'] ?? 'full'] ?? new RegExp(process.env['HOST_SUITE'] ?? '');
const stateDir = process.env['HOST_STATE_DIR'] ?? join(root, 'test-results', 'hosts-state');

const projects: NonNullable<PlaywrightTestConfig['projects']> = [];
for (const host of hosts) {
  for (const browser of browsers) {
    const key = `${host.name}-${browser}`;
    const use = { ...BROWSERS[browser], baseURL: `http://localhost:${host.port}`, hostName: host.name, hostKey: key };
    projects.push(
      { name: `setup-${key}`, testMatch: /project\.setup\.ts/, use, teardown: `teardown-${key}` },
      { name: `teardown-${key}`, testMatch: /project\.teardown\.ts/, use },
      {
        name: key,
        testMatch: suite,
        dependencies: [`setup-${key}`],
        // One visitor per project: its tests take turns, other projects run alongside.
        workers: 1,
        // The rich suite's full matrix (@matrix) runs on Chromium; WebKit and Firefox run its representative subset.
        ...(browser === 'chromium' ? {} : { grepInvert: /@matrix/ }),
        use: { ...use, storageState: join(stateDir, `${key}.storage.json`) },
      },
    );
  }
}

export default defineConfig({
  testDir: '.',
  outputDir: join(root, 'test-results', 'hosts'),
  fullyParallel: false,
  // The backend is a dev box: three browsers at a time.
  workers: Number(process.env['HOST_WORKERS'] ?? 3),
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: join(stateDir, 'results.json') }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 20_000 },
  projects,
  webServer: hosts.map((h) => ({
    command: h.command,
    cwd: root,
    url: `http://localhost:${h.port}/`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'ignore' as const,
  })),
});
