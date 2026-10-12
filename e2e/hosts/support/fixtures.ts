/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { LiveBackend, type Definition, type Report } from '../live-backend';

/** The one web origin project 2796 links; the hosts' own origins are sent as this so authentication passes. */
export const LINKED_ORIGIN = process.env['HOST_LINKED_ORIGIN'] ?? 'http://localhost:4173';
export const SHOW_TIMEOUT = 20_000;
export const COUNTER_TIMEOUT = 10_000;
/** The batch worker takes a few seconds per batch on the dev box; the plan's 10 s is measured from the flush. */
export const REPORT_TIMEOUT = Number(process.env['HOST_REPORT_TIMEOUT'] ?? 30_000);

export interface ProjectState {
  identifier: string;
  segment: string;
  visitor: number;
  storage: string;
}

export interface HostOptions {
  hostName: 'plain' | 'react' | 'next' | 'vue';
  hostKey: string;
}

export interface OpenOptions {
  /** Drops the stored session so the load is a new visit and fires app_open. */
  freshSession?: boolean;
  /** Campaign ids the host lets through beforeShow; anything else in the project is vetoed. */
  allow?: string[];
  /** Waits for an in-app sync whose answer names this campaign, or any sync answer with true. */
  waitFor?: string | true;
  paused?: boolean;
  /** Turns on the SDK's in-app decision log (on unless false). */
  debug?: boolean;
}

export function statePath(stateDir: string, hostKey: string): string {
  return join(stateDir, `${hostKey}.json`);
}

export function readState(stateDir: string, hostKey: string): ProjectState {
  return JSON.parse(readFileSync(statePath(stateDir, hostKey), 'utf8')) as ProjectState;
}

/** Sends the IDENTIFIER header as the linked origin; the SDK sets it from the page origin, which the project does not list. */
export async function linkOrigin(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({ identifier: LINKED_ORIGIN });
}

export class Host {
  readonly campaigns: string[] = [];
  readonly console: string[] = [];
  private installed = false;

  constructor(
    readonly page: Page,
    readonly backend: LiveBackend,
    readonly state: ProjectState,
    readonly name: HostOptions['hostName'],
    readonly origin: string,
  ) {
    page.on('console', (message) => this.console.push(message.text()));
  }

  get message(): Locator {
    return this.page.locator('#grovs-in-app');
  }

  /** The html message's page. */
  get frame() {
    return this.page.frameLocator('#grovs-in-app iframe');
  }

  get lastAction(): Locator {
    return this.page.locator('#host-last-action');
  }

  async open(path = '/', options: OpenOptions = {}): Promise<void> {
    const config = {
      apiKey: process.env['HOST_SDK_KEY'],
      baseURL: process.env['HOST_BASE_URL'],
      identifier: this.state.identifier,
      allow: options.allow ?? this.campaigns,
      paused: options.paused === true,
      debug: options.debug !== false,
    };
    const settings = { ...config, fresh: options.freshSession === true };
    if (this.installed && this.page.url().startsWith(this.origin)) {
      await this.page.evaluate((value) => sessionStorage.setItem('zz_host', JSON.stringify(value)), settings);
    } else if (!this.installed) {
      this.installed = true;
      await this.page.addInitScript((initial) => {
        // The latest settings ride in sessionStorage, so one script serves every load in the test.
        const stored = sessionStorage.getItem('zz_host');
        const host = stored ? (JSON.parse(stored) as typeof initial) : initial;
        (window as unknown as { __HOST__: unknown }).__HOST__ = host;
        // The stored visit is kept alive across the run, or a test an hour in would start a new one.
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i) ?? '';
          if (host.fresh && key.startsWith('grovs_session')) localStorage.removeItem(key);
          else if (!host.fresh && key.startsWith('grovs_session_activity')) localStorage.setItem(key, String(Date.now()));
        }
        sessionStorage.setItem('zz_host', JSON.stringify({ ...host, fresh: false }));
        // The most messages ever on the page at once: a duplicate shows here even if it lasted a frame.
        const w = window as unknown as { __maxMessages: number };
        w.__maxMessages = 0;
        new MutationObserver(() => {
          w.__maxMessages = Math.max(w.__maxMessages, document.querySelectorAll('#grovs-in-app').length);
        }).observe(document, { childList: true, subtree: true });
      }, settings);
    }
    const synced = options.waitFor ? this.waitForSync(options.waitFor) : null;
    await this.page.goto(path);
    await expect(this.page.locator('h1')).toBeVisible();
    if (synced) await synced;
  }

  /** Resolves once an in-app sync answer lists the campaign (any answer, for true). */
  waitForSync(id: string | true): Promise<unknown> {
    return this.page.waitForResponse(
      async (response) => {
        if (!response.url().endsWith('/in_app/sync')) return false;
        const text = await response.text().catch(() => '');
        if (process.env['HOST_DEBUG']) console.log('sync', text.slice(0, 300));
        return id === true || text.includes(`"id":"${id}"`);
      },
      { timeout: SHOW_TIMEOUT },
    );
  }

  /** Creates and launches a campaign for this project's visitor; the page is not opened. */
  async create(caseName: string, definition: Definition, prepare?: (id: string) => Promise<void>): Promise<string> {
    const id = await this.backend.createCampaign(`${this.name} ${caseName}`, definition, this.state.segment);
    this.campaigns.push(id);
    if (prepare) await prepare(id);
    const members = await this.backend.launch(id);
    expect(members, `segment of ${id} does not hold visitor ${this.state.visitor}`).toContain(this.state.visitor);
    return id;
  }

  /** Creates, launches and opens the host on a fresh sync that carries it. */
  async show(
    caseName: string,
    definition: Definition,
    options: OpenOptions & { path?: string; prepare?: ((id: string) => Promise<void>) | undefined } = {},
  ): Promise<string> {
    const id = await this.create(caseName, definition, options.prepare);
    await this.open(options.path ?? '/', { ...options, waitFor: id });
    return id;
  }

  async trigger(): Promise<void> {
    await this.page.locator('#host-trigger').click();
  }

  async track(name: string, properties: Record<string, unknown> = {}): Promise<void> {
    await this.page.evaluate(
      ([event, props]) => (window as unknown as { __hostGrovs: { track(n: string, p: unknown): void } }).__hostGrovs.track(event, props),
      [name, properties] as const,
    );
  }

  async flush(): Promise<void> {
    await this.page.evaluate(() => (window as unknown as { __hostGrovs: { flush(): Promise<void> } }).__hostGrovs.flush());
  }

  async maxMessages(): Promise<number> {
    return this.page.evaluate(() => (window as unknown as { __maxMessages: number }).__maxMessages);
  }

  /** Waits for the SDK's decision log to mention the campaign with this reason. */
  async skipped(id: string, reason: string): Promise<void> {
    await expect.poll(() => this.console.some((line) => line.includes(`${id}: ${reason}`)), { timeout: SHOW_TIMEOUT }).toBe(true);
  }

  async log(): Promise<{ cb: string; id: string; reason?: string; value?: unknown; payload?: unknown }[]> {
    return this.page.evaluate(() => (window as unknown as { __hostLog: [] }).__hostLog ?? []);
  }

  /** Flushes the page's queue, then polls the report until `until` holds. */
  async report(id: string, until: (report: Report) => boolean, timeout = REPORT_TIMEOUT): Promise<Report> {
    if (!this.page.isClosed()) await this.flush().catch(() => undefined);
    return this.backend.waitForReport(id, timeout, until);
  }
}

export const test = base.extend<HostOptions & { backend: LiveBackend; host: Host }>({
  hostName: ['plain', { option: true }],
  hostKey: ['plain-chromium', { option: true }],
  backend: async ({}, use) => {
    await use(LiveBackend.shared());
  },
  context: async ({ context }, use) => {
    await linkOrigin(context);
    await use(context);
  },
  host: async ({ page, backend, hostKey, hostName, baseURL }, use) => {
    const host = new Host(page, backend, readState(backend.stateDir, hostKey), hostName, baseURL ?? '');
    await use(host);
    for (const id of host.campaigns) await backend.cleanUp(id).catch(() => undefined);
  },
});

export { expect };
