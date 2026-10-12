/// <reference types="node" />
import { appendFileSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

/** Counts the dashboard report gives for one campaign. */
export interface Report {
  views: number;
  clicks: number;
  dismissals: number;
  answers: number;
  /** Clicks per button id; '' is a click with no button (an html page's track or open). */
  buttons: Record<string, number>;
}

/** A tracked event as the analytics API lists it. */
export interface TrackedEvent {
  event_id: string;
  event_name: string;
  visitor_id: number;
  sdk_identifier: string;
}

export type Definition = Record<string, unknown>;

interface Visitor {
  id: number;
  held: boolean;
  profiles: number;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run the suite through scripts/run_host_tests.sh`);
  return value;
}

const SEGMENT_DEFINITION = {
  version: 1,
  operator: 'and',
  groups: [{ operator: 'and', conditions: [{ type: 'identifier', op: 'in_list' }] }],
};

/**
 * The dashboard API, as the iOS LiveBackend drives it: create, launch, report, end.
 * The two steps the API cannot do (a segment's first population, reading a visitor)
 * go to the run's helper process, which only acts on this run's records.
 */
export class LiveBackend {
  static shared(): LiveBackend {
    return new LiveBackend(
      env('HOST_TEST_API'),
      env('HOST_TEST_TOKEN'),
      env('HOST_TEST_PROJECT'),
      env('HOST_TEST_RUN_ID'),
      Number(process.env['HOST_HELPER_PORT'] ?? 4809),
      env('HOST_STATE_DIR'),
    );
  }

  private polls = 0;

  constructor(
    readonly api: string,
    private readonly token: string,
    readonly project: string,
    readonly runId: string,
    private readonly helperPort: number,
    readonly stateDir: string,
  ) {}

  identifier(suffix: string): string {
    return `zz-qa-host-${this.runId}-${suffix}`;
  }

  campaignName(name: string): string {
    return `zz-qa host ${this.runId} ${name}`;
  }

  async createSegment(name: string): Promise<string> {
    const body = await this.request('POST', '/segments', { name: this.campaignName(name), definition: SEGMENT_DEFINITION });
    const id = String((body['segment'] as Record<string, unknown>)['id']);
    this.record('segments', id);
    return id;
  }

  async uploadIdentifiers(segment: string, identifiers: string[]): Promise<void> {
    await this.request('POST', `/segments/${segment}/identifier_list`, { identifiers });
  }

  /** A draft named for this run, aimed at the segment that holds only this project's identifier. */
  async createCampaign(name: string, definition: Definition, segment: string): Promise<string> {
    const body = await this.request('POST', '/in_app_campaigns', {
      name: this.campaignName(name),
      ...definition,
      audience: { type: 'segment', segment_id: segment },
    });
    const id = String((body['in_app_campaign'] as Record<string, unknown>)['id']);
    this.record('campaigns', id);
    return id;
  }

  /** Launches, then runs the segment's first population so the campaign goes live. */
  async launch(id: string): Promise<number[]> {
    await this.request('POST', `/in_app_campaigns/${id}/launch`);
    const answer = await this.helper({ op: 'populate', id });
    if (answer['status'] !== 'live') throw new Error(`campaign ${id} did not go live: ${JSON.stringify(answer)}`);
    return answer['members'] as number[];
  }

  async end(id: string): Promise<void> {
    await this.request('POST', `/in_app_campaigns/${id}/end`);
  }

  /** The API deletes drafts only; a launched campaign is ended instead. */
  async delete(id: string): Promise<void> {
    await this.request('DELETE', `/in_app_campaigns/${id}`);
  }

  async status(id: string): Promise<string> {
    const body = await this.request('GET', `/in_app_campaigns/${id}`);
    return String((body['in_app_campaign'] as Record<string, unknown>)['status']);
  }

  /** Ends it through the API as an owner would, then hard-deletes it by exact id (the API deletes drafts only). */
  async cleanUp(id: string): Promise<void> {
    const status = await this.status(id).catch(() => 'unknown');
    if (['preparing', 'scheduled', 'live', 'paused'].includes(status)) await this.end(id);
    await this.purge([id], []);
  }

  /** Hard-deletes this run's campaigns and segments by exact id, with their files, memberships and queued jobs. */
  async purge(campaigns: string[], segments: string[]): Promise<Record<string, number>> {
    const answer = await this.helper({ op: 'purge', campaigns, segments });
    return answer['deleted'] as Record<string, number>;
  }

  async uploadImage(id: string, slot: 'portrait' | 'landscape', png: Buffer): Promise<void> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${slot}.png`);
    await this.request('POST', `/in_app_campaigns/${id}/images/${slot}`, form);
  }

  async uploadMedia(id: string, file: Buffer, type: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type }), filename);
    const body = await this.request('POST', `/in_app_campaigns/${id}/media`, form);
    return String((body['media'] as Record<string, unknown>)['url']);
  }

  async patch(id: string, fields: Definition): Promise<void> {
    await this.request('PATCH', `/in_app_campaigns/${id}`, fields);
  }

  /** The report is cached per date range for a minute, so each read asks for a range not asked before. */
  async report(id: string): Promise<Report> {
    const day = 86_400_000;
    const n = this.polls++;
    const from = new Date(Date.now() - (n % 85) * day).toISOString().slice(0, 10);
    const to = new Date(Date.now() + day).toISOString().slice(0, 10);
    const by = Math.floor(n / 85) % 2 === 0 ? 'day' : 'hour';
    const body = await this.request('GET', `/in_app_campaigns/${id}/report?from=${from}&to=${to}&by=${by}`);
    const report = body['report'] as Record<string, unknown>;
    const totals = report['totals'] as Record<string, number>;
    const answers = report['answers'] as { count?: number } | null;
    const buttons = (report['buttons'] as { button_id: string | null; clicks: number }[] | undefined) ?? [];
    return {
      views: totals['views'] ?? 0,
      clicks: totals['clicks'] ?? 0,
      dismissals: totals['dismissals'] ?? 0,
      answers: answers?.count ?? 0,
      buttons: Object.fromEntries(buttons.map((b) => [b.button_id ?? '', b.clicks])),
    };
  }

  /** Events named exactly `name` from this identifier, from yesterday to tomorrow (UTC). */
  async events(name: string, identifier: string): Promise<TrackedEvent[]> {
    const day = 86_400_000;
    const from = new Date(Date.now() - day).toISOString().slice(0, 10);
    const to = new Date(Date.now() + day).toISOString().slice(0, 10);
    const query = new URLSearchParams({ start_date: from, end_date: to, search: name, limit: '50' });
    const body = await this.request('GET', `/analytics/events?${query.toString()}`);
    const rows = (body['data'] as TrackedEvent[] | undefined) ?? [];
    return rows.filter((e) => e.event_name === name && e.sdk_identifier === identifier);
  }

  /** One event's properties. */
  async eventProperties(id: string): Promise<Record<string, unknown>> {
    const body = await this.request('GET', `/analytics/events/${id}`);
    return ((body['data'] as Record<string, unknown>)['properties'] as Record<string, unknown> | null) ?? {};
  }

  /** The visitor's attributes as stored. */
  async visitorAttributes(visitor: number): Promise<Record<string, unknown>> {
    const body = await this.request('GET', `/visitors/${visitor}`);
    return ((body['visitor'] as Record<string, unknown>)['sdk_attributes'] as Record<string, unknown> | null) ?? {};
  }

  /** Polls until `until` holds, or fails naming the last counts seen. */
  async waitForReport(id: string, timeoutMs: number, until: (report: Report) => boolean): Promise<Report> {
    const deadline = Date.now() + timeoutMs;
    let last: Report | null = null;
    for (;;) {
      last = await this.report(id);
      if (until(last)) return last;
      if (Date.now() > deadline) throw new Error(`report for ${id} never matched; last ${JSON.stringify(last)}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async visitors(identifier: string): Promise<Visitor[]> {
    const answer = await this.helper({ op: 'visitors', identifier });
    return answer['visitors'] as Visitor[];
  }

  /** Writes the visitor's identified profile to ClickHouse now, as the job the API queues would. */
  async syncProfile(identifier: string, visitor: number): Promise<void> {
    await this.helper({ op: 'profile', identifier, visitor });
  }

  helper(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.helperPort, '127.0.0.1');
      let data = '';
      socket.setTimeout(120_000, () => socket.destroy(new Error('host helper timed out')));
      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (!data.includes('\n')) return;
        socket.end();
        const answer = JSON.parse(data) as Record<string, unknown>;
        if (answer['ok'] === true) resolve(answer);
        else reject(new Error(`host helper: ${String(answer['error'])}`));
      });
      socket.on('error', reject);
    });
  }

  private record(kind: string, id: string): void {
    mkdirSync(this.stateDir, { recursive: true });
    appendFileSync(join(this.stateDir, `${kind}.txt`), `${id}\n`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const form = body instanceof FormData;
    const response = await fetch(`${this.api}/projects/${this.project}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
}
