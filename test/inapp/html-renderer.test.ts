import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../../src/logging/logger';
import { BRIDGE } from '../../src/inapp/bridge.generated';
import type { Outcome, Page } from '../../src/inapp/controller';
import { readCampaign } from '../../src/inapp/definition';
import { InAppRenderer } from '../../src/inapp/renderer';
import { merge, readJson } from './shared';

type Json = Record<string, unknown>;

const BASE = readJson('cases.json').base_campaign as Json;
const PAGE = '<!doctype html><p>Hi</p>';

function open(content: Json = {}, body = PAGE, eligible = () => true) {
  const campaign = readCampaign(merge(BASE, { template: 'html', content: { html: 'stored', layout: 'modal', ...content } }));
  if (!campaign) throw new Error('campaign did not read');
  const logger = new Logger();
  logger.setLevel('warn');
  const warnings = vi.spyOn(logger, 'warn');
  const visited: string[] = [];
  const renderer = new InAppRenderer(document, logger, (url) => visited.push(url));
  const sent: { tracked: [string, Json][]; attributes: [string, unknown][] } = { tracked: [], attributes: [] };
  const page: Page = {
    body,
    user: { name: 'Ana</script>' },
    event: { sku: 'A1' },
    actions: {
      track: (name, properties) => sent.tracked.push([name, properties]),
      setAttribute: (key, value) => sent.attributes.push([key, value]),
    },
    eligible,
  };
  const outcome: { value: Outcome | null } = { value: null };
  let drawn = 0;
  void renderer
    .present({ campaign, rendered: { title: null, message: null, buttons: [], urls: [] }, page }, () => (drawn += 1))
    .then((value) => (outcome.value = value));
  const root = document.getElementById('grovs-in-app')?.shadowRoot;
  if (!root) throw new Error('nothing was drawn');
  return { renderer, root, outcome, visited, sent, warnings, drawn: () => drawn };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** jsdom gives a frame in a shadow root no window, so each gets a stand-in that records replies. */
const replies = new WeakMap<HTMLIFrameElement, unknown[]>();

function frameOf(root: ShadowRoot): HTMLIFrameElement {
  const frame = root.querySelector('iframe');
  if (!frame) throw new Error('no frame');
  if (!replies.has(frame)) {
    const sent: unknown[] = [];
    replies.set(frame, sent);
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage: (message: unknown) => sent.push(message) } });
  }
  return frame;
}

function message(data: unknown, source: unknown): Event {
  return Object.assign(new Event('message'), { data, source });
}

function tokenOf(frame: HTMLIFrameElement): string {
  return /token:"([^"]+)"/.exec(frame.srcdoc)?.[1] ?? '';
}

/** What bridge.js would post from inside the frame. */
function post(frame: HTMLIFrameElement, type: string, args: Json = {}, changes: Json = {}): void {
  const data = { v: 1, token: tokenOf(frame), id: String(Math.random()), type, args, ...changes };
  window.dispatchEvent(message(data, frame.contentWindow));
}

async function shownPage(content: Json = {}) {
  const opened = open(content);
  await settle();
  const frame = frameOf(opened.root);
  post(frame, 'ready', { missing: false });
  post(frame, 'height', { value: 120 });
  return { ...opened, frame };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('html messages', () => {
  it('builds a sandboxed frame with autoplay and the bridge injected right after the doctype', async () => {
    const { root } = open();
    await settle();
    const frame = frameOf(root);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('allow')).toBe('autoplay; fullscreen');
    expect(frame.srcdoc.startsWith('<!doctype html><script>window.__grovs={')).toBe(true);
    expect(frame.srcdoc).toContain(BRIDGE);
    expect(frame.srcdoc.endsWith('</script><p>Hi</p>')).toBe(true);
    expect(frame.srcdoc).toContain('"pushPermission":"unsupported"');
    expect(frame.srcdoc).toContain('Ana\\u003c/script>');
    expect(frame.srcdoc).toContain('"sku":"A1"');
    expect(frame.srcdoc).toContain('p.postMessage.bind(p)');
    expect(tokenOf(frame)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps a doctype after leading whitespace and comments first, so the page stays in standards mode', async () => {
    const { root } = open({}, '\n <!-- a --> <!--b--><!DOCTYPE html><p>Hi</p>');
    await settle();
    expect(frameOf(root).srcdoc.startsWith('\n <!-- a --> <!--b--><!DOCTYPE html><script>window.__grovs=')).toBe(true);
  });

  it('gives a page without a doctype one, so it is not in quirks mode, then the script', async () => {
    const { root } = open({}, '<p>Hi</p>');
    await settle();
    expect(frameOf(root).srcdoc.startsWith('<!doctype html><script>window.__grovs=')).toBe(true);
  });

  it('stays invisible until ready and a height, then counts the view once', async () => {
    const { root, drawn } = open();
    await settle();
    const frame = frameOf(root);
    const layer = root.querySelector('.layer');
    expect(layer?.classList.contains('pending')).toBe(true);
    post(frame, 'height', { value: 0 });
    post(frame, 'ready', { missing: false });
    expect(drawn()).toBe(0);
    post(frame, 'height', { value: 180 });
    expect(frame.style.height).toBe('180px');
    expect(layer?.classList.contains('pending')).toBe(false);
    post(frame, 'height', { value: 200 });
    expect(drawn()).toBe(1);
  });

  it('shows a full page at ready alone and ignores its heights', async () => {
    const { root, drawn } = open({ layout: 'full' });
    await settle();
    const frame = frameOf(root);
    post(frame, 'ready', { missing: false });
    expect(drawn()).toBe(1);
    post(frame, 'height', { value: 50 });
    expect(frame.style.height).toBe('');
  });

  it('ignores messages with a wrong token, version or source', async () => {
    const { root, drawn } = open();
    await settle();
    const frame = frameOf(root);
    post(frame, 'ready', { missing: false }, { token: 'guess' });
    post(frame, 'ready', { missing: false }, { v: 2 });
    window.dispatchEvent(message({ v: 1, token: tokenOf(frame), id: '1', type: 'ready', args: { missing: false } }, window));
    post(frame, 'height', { value: 100 });
    expect(drawn()).toBe(0);
  });

  it('a missing field skips the message uncounted', async () => {
    const { root, outcome, drawn } = open();
    await settle();
    post(frameOf(root), 'ready', { missing: true });
    await settle();
    expect(outcome.value).toEqual({ kind: 'dismissed', reason: 'failed', missing: true });
    expect(drawn()).toBe(0);
    expect(document.getElementById('grovs-in-app')).toBeNull();
  });

  it('one five second deadline covers the wait for ready', async () => {
    vi.useFakeTimers();
    const { outcome, warnings, drawn } = open();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(outcome.value).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.value).toEqual({ kind: 'dismissed', reason: 'failed' });
    expect(String(warnings.mock.calls[0]?.[0])).toContain('in_app.html_timeout');
    expect(drawn()).toBe(0);
  });

  it('a deadline that finds the page not eligible asks again and logs no timeout', async () => {
    vi.useFakeTimers();
    const eligible = vi.fn(() => false);
    const { outcome, warnings } = open({}, PAGE, eligible);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(outcome.value).toEqual({ kind: 'dismissed', reason: 'failed' });
    expect(eligible).toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it('a page that loads but never reports a height times out, and late messages are ignored', async () => {
    vi.useFakeTimers();
    const { root, outcome, drawn } = open();
    await vi.advanceTimersByTimeAsync(0);
    const frame = frameOf(root);
    post(frame, 'ready', { missing: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(outcome.value).toEqual({ kind: 'dismissed', reason: 'failed' });
    post(frame, 'height', { value: 100 });
    expect(drawn()).toBe(0);
  });

  it('asks again before revealing; a page no longer eligible is torn down uncounted', async () => {
    let eligible = true;
    const { root, outcome, drawn } = open({}, PAGE, () => eligible);
    await settle();
    const frame = frameOf(root);
    eligible = false;
    post(frame, 'ready', { missing: false });
    post(frame, 'height', { value: 120 });
    await settle();
    expect(outcome.value).toEqual({ kind: 'dismissed', reason: 'failed' });
    expect(drawn()).toBe(0);
    expect(document.getElementById('grovs-in-app')).toBeNull();
  });

  it('a second load means the page navigated itself: torn down, and its messages ignored', async () => {
    const { frame, outcome, sent } = await shownPage();
    frame.dispatchEvent(new Event('load'));
    frame.dispatchEvent(new Event('load'));
    await settle();
    expect(outcome.value).toEqual({ kind: 'dismissed', reason: 'app' });
    post(frame, 'setAttribute', { key: 'plan', value: 'pro' });
    expect(sent.attributes).toEqual([]);
  });

  it('always draws its own close control, which closes', async () => {
    const { root, outcome } = await shownPage({ close_button: false, dismissible: false });
    const close = root.querySelector<HTMLButtonElement>('button.close');
    expect(close?.getAttribute('aria-label')).toBe('Close');
    close?.click();
    await settle();
    expect(outcome.value).toEqual({ kind: 'dismissed', reason: 'close_button' });
  });

  it('close from the page closes', async () => {
    const { frame, outcome } = await shownPage();
    post(frame, 'close');
    await settle();
    expect(outcome.value).toEqual({ kind: 'dismissed', reason: 'close_button' });
  });

  it('open follows the link rule, ignores a fragment or a call without a tap in the frame, navigates and closes as a click', async () => {
    const { frame, outcome, visited } = await shownPage();
    post(frame, 'open', { url: 'javascript:alert(1)' });
    post(frame, 'open', { url: 'http://acme.example' });
    post(frame, 'open', { url: '#more' });
    await settle();
    expect(outcome.value).toBeNull();
    expect(visited).toEqual([]);
    post(frame, 'open', { url: 'https://acme.example/b', active: false });
    await settle();
    expect(outcome.value).toBeNull();
    expect(visited).toEqual([]);
    post(frame, 'open', { url: ' https://acme.example/a ', active: true });
    await settle();
    expect(visited).toEqual(['https://acme.example/a']);
    expect(outcome.value).toEqual({ kind: 'clicked', buttonId: null, action: { type: 'open_url', url: 'https://acme.example/a' } });
  });

  it('track and setAttribute reach the SDK once shown, validated, and reserved names are refused', async () => {
    const { frame, sent, outcome } = await shownPage();
    post(frame, 'track', { name: 'liked', properties: { stars: 5 } });
    post(frame, 'track', { name: 'in_app_clicked', properties: {} });
    post(frame, 'track', { name: 'app_open', properties: {} });
    post(frame, 'track', { name: '', properties: {} });
    post(frame, 'track', { name: 'x'.repeat(101), properties: {} });
    post(frame, 'track', { name: 'list', properties: [1] });
    post(frame, 'setAttribute', { key: 'plan', value: 'pro' });
    post(frame, 'setAttribute', { key: 'age', value: 31 });
    post(frame, 'setAttribute', { key: 'bad', value: { nested: true } });
    post(frame, 'setAttribute', { key: '', value: 'x' });
    expect(sent.tracked).toEqual([['liked', { stars: 5 }]]);
    expect(sent.attributes).toEqual([
      ['plan', 'pro'],
      ['age', 31],
    ]);
    expect(outcome.value).toBeNull();
  });

  it('before it is shown, calls are dropped and push permission is refused as not_shown', async () => {
    const { root, sent, outcome } = open();
    await settle();
    const frame = frameOf(root);
    post(frame, 'track', { name: 'liked', properties: {} });
    post(frame, 'close');
    post(frame, 'requestPushPermission', {}, { id: 'p1' });
    await settle();
    expect(sent.tracked).toEqual([]);
    expect(outcome.value).toBeNull();
    expect(replies.get(frame)).toEqual([{ v: 1, id: 'p1', ok: false, error: 'not_shown' }]);

    post(frame, 'ready', { missing: false });
    post(frame, 'height', { value: 10 });
    post(frame, 'requestPushPermission', {}, { id: 'p2' });
    expect(replies.get(frame)?.[1]).toEqual({ v: 1, id: 'p2', ok: true, result: 'unsupported' });
  });

  it('a banner layout takes no focus and leaves the page usable', async () => {
    const { root } = await shownPage({ layout: 'banner_bottom' });
    const layer = root.querySelector('.layer');
    expect(layer?.classList.contains('banner')).toBe(true);
    expect(layer?.classList.contains('banner_bottom')).toBe(true);
    expect(layer?.classList.contains('dim')).toBe(false);
  });

  it('a modal dims behind it and closes on a backdrop tap when dismissible', async () => {
    const { root, outcome } = await shownPage();
    const layer = root.querySelector<HTMLElement>('.layer');
    expect(layer?.classList.contains('dim')).toBe(true);
    layer?.click();
    await settle();
    expect(outcome.value).toEqual({ kind: 'dismissed', reason: 'backdrop' });
  });
});
