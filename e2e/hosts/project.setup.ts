/// <reference types="node" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { LiveBackend } from './live-backend';
import { linkOrigin, statePath, type HostOptions, type ProjectState } from './support/fixtures';

const setup = base.extend<HostOptions>({
  hostName: ['plain', { option: true }],
  hostKey: ['plain-chromium', { option: true }],
});

// One visitor per host and browser for the whole run: its identifier is the only entry in its segment.
setup('host visitor and segment', async ({ page, context, hostKey }) => {
  setup.setTimeout(300_000);
  const backend = LiveBackend.shared();
  const identifier = backend.identifier(hostKey);
  await linkOrigin(context);
  await page.addInitScript((host) => {
    (window as unknown as { __HOST__: unknown }).__HOST__ = host;
    if (location.search.includes('zz_reset')) localStorage.clear();
  }, { apiKey: process.env['HOST_SDK_KEY'], baseURL: process.env['HOST_BASE_URL'], identifier, allow: [], paused: true });

  let visitor = 0;
  // A visitor the project's control group holds back never receives a message: start again as another.
  for (let attempt = 0; attempt < 5 && visitor === 0; attempt++) {
    await context.clearCookies();
    const attributes = page.waitForResponse((r) => r.url().endsWith('/visitor_attributes') && r.request().method() !== 'GET');
    await page.goto(`/?zz_reset=${attempt}`);
    const answer = await attributes;
    expect(answer.status()).toBe(200);
    const mine = Number(((await answer.json()) as { visitor: { id: number } }).visitor.id);
    await page.evaluate(() => (window as unknown as { __hostGrovs: { track(n: string): void } }).__hostGrovs.track('zz_qa_setup'));
    await page.evaluate(() => (window as unknown as { __hostGrovs: { flush(): Promise<void> } }).__hostGrovs.flush());
    // The identifier is written by a request of its own, which can land after this answer, and the helper may be busy; if it never shows, start again.
    let found: Awaited<ReturnType<typeof backend.visitors>>[number] | undefined;
    const stored = await expect
      .poll(async () => (found = (await backend.visitors(identifier)).find((v) => v.id === mine)), { timeout: 60_000 })
      .toBeTruthy()
      .then(() => true, () => false);
    if (!stored) console.log(`visitor ${mine} is not stored with ${identifier}; trying another`);
    if (stored && !found?.held) visitor = mine;
  }
  expect(visitor, 'every visitor tried was in the project control group or never stored').not.toBe(0);
  await backend.syncProfile(identifier, visitor);
  // The segment is read from ClickHouse, so the identified profile must be there before the list is used.
  await expect
    .poll(async () => (await backend.visitors(identifier)).find((v) => v.id === visitor)?.profiles ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(0);

  const segment = await backend.createSegment(`segment ${hostKey}`);
  await backend.uploadIdentifiers(segment, [identifier]);
  mkdirSync(backend.stateDir, { recursive: true });
  const storage = join(backend.stateDir, `${hostKey}.storage.json`);
  await context.storageState({ path: storage });
  const state: ProjectState = { identifier, segment, visitor, storage };
  writeFileSync(statePath(backend.stateDir, hostKey), JSON.stringify(state, null, 2));
});
