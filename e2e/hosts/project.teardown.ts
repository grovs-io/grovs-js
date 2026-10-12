/// <reference types="node" />
import { existsSync } from 'node:fs';
import { test as base } from '@playwright/test';
import { LiveBackend } from './live-backend';
import { readState, statePath, type HostOptions } from './support/fixtures';

const teardown = base.extend<HostOptions>({
  hostName: ['plain', { option: true }],
  hostKey: ['plain-chromium', { option: true }],
});

teardown('delete the segment', async ({ hostKey }) => {
  const backend = LiveBackend.shared();
  if (!existsSync(statePath(backend.stateDir, hostKey))) return;
  await backend.purge([], [readState(backend.stateDir, hostKey).segment]);
});
