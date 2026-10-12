/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { SHOW_TIMEOUT, expect, test, type Host } from './fixtures';
import { EVENT, html, native, page, question } from './definitions';
import type { Definition } from '../live-backend';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const IMAGE_ONLY = ['cover_image', 'interstitial_image', 'half_interstitial_image'];
const EXAMPLE = 'https://example.com/zz-qa';

/** Polls the report for a few seconds and fails if `check` ever stops holding. */
async function staysAt(host: Host, id: string, check: (r: Awaited<ReturnType<Host['backend']['report']>>) => boolean, ms = 5_000) {
  await host.flush().catch(() => undefined);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const report = await host.backend.report(id);
    expect(check(report), `report moved: ${JSON.stringify(report)}`).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** A click on the page outside any card. */
async function tapOutside(host: Host) {
  await host.page.mouse.click(4, 4);
}

async function stubExample(host: Host) {
  await host.page.context().route('https://example.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>zz example</h1>' }),
  );
}

// MARK: A. Showing up

export async function nativeTemplate(host: Host, template: string) {
  const imageOnly = IMAGE_ONLY.includes(template);
  const image = template.endsWith('_image');
  const id = await host.show(`A1 ${template}`, native(template), {
    prepare: image ? (campaign) => host.backend.uploadImage(campaign, 'portrait', fixture('portrait.png')) : undefined,
  });
  // A message whose picture has not loaded yet is skipped as not_ready, so the trigger repeats until it shows.
  await expect(async () => {
    await host.trigger();
    await expect(host.message).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  if (imageOnly) {
    await expect(host.message.locator('img.media')).toBeVisible();
    await host.message.getByRole('button', { name: 'Close' }).click();
    await expect(host.message).toHaveCount(0);
    await host.report(id, (r) => r.views === 1 && r.dismissals === 1);
    return;
  }
  await expect(host.message.getByText(`zz title ${template}`)).toBeVisible();
  await expect(host.message.getByText(`zz message ${template}`)).toBeVisible();
  await expect(host.message.getByRole('button', { name: 'zz KV' })).toBeVisible();
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await expect(host.message).toHaveCount(0);
  await host.report(id, (r) => r.views === 1 && r.clicks === 1);
}

export async function htmlLayout(host: Host, layout: string) {
  const id = await host.show(`A2 ${layout}`, html(layout, page(`<main style="padding:16px"><h2>zz html ${layout}</h2><p>zz body</p></main>`)));
  await host.trigger();
  await expect(host.frame.getByText(`zz html ${layout}`)).toBeVisible();
  const close = host.message.getByRole('button', { name: 'Close' });
  await expect(close).toBeVisible();
  await close.click();
  await expect(host.message).toHaveCount(0);
  await host.report(id, (r) => r.views === 1 && r.dismissals === 1);
}

export async function fullDesignAsCard(host: Host) {
  const body = page('<div style="height:100%;background:#1e78dc;color:#fff">zz full design</div>', '<style>html,body{height:100%;margin:0}</style>');
  const id = await host.show('A3 full design in modal', html('modal', body));
  await host.trigger();
  await expect(host.frame.getByText('zz full design')).toBeVisible();
  const frame = await host.message.locator('iframe').boundingBox();
  const viewport = host.page.viewportSize();
  expect(frame && viewport ? frame.height / viewport.height : 0).toBeGreaterThanOrEqual(0.8);
  await host.message.getByRole('button', { name: 'Close' }).click();
  await host.report(id, (r) => r.views === 1);
}

export async function tinyPageKeepsClose(host: Host) {
  const id = await host.show('A4 tiny page', html('banner_top', page('<div style="height:1px"></div>', '<style>html,body{margin:0}</style>')));
  await host.trigger();
  const close = host.message.getByRole('button', { name: 'Close' });
  await expect(close).toBeVisible();
  const box = await close.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  await close.click();
  await expect(host.message).toHaveCount(0);
  await host.report(id, (r) => r.views === 1 && r.dismissals === 1);
}

export async function personalisationDefault(host: Host) {
  const id = await host.show('A5 default', native('alert', { title: 'zz hi {{ user.first_name | default: "friend" }}' }));
  await host.trigger();
  await expect(host.message.getByText('zz hi friend')).toBeVisible();
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await host.report(id, (r) => r.views === 1);
}

export async function personalisationMissing(host: Host) {
  const id = await host.show('A5 missing', native('alert', { title: 'zz hi {{ user.zz_never_set }}' }));
  await host.trigger();
  await host.skipped(id, 'personalization');
  await expect(host.message).toHaveCount(0);
  await staysAt(host, id, (r) => r.views === 0);
}

// MARK: B. Where it appears

export async function overSecondRoute(host: Host) {
  const id = await host.show('B6 second route', native('interstitial'), { path: '/second' });
  await expect(host.page.locator('h1')).toHaveText('Second');
  await host.trigger();
  await expect(host.message.getByText('zz title interstitial')).toBeVisible();
  // Topmost: the middle of the page is the message, not the host's content.
  expect(await host.page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.id)).toBe('grovs-in-app');
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await expect(host.message).toHaveCount(0);
  await host.report(id, (r) => r.views === 1 && r.clicks === 1);
}

export async function withFieldFocused(host: Host) {
  const id = await host.show('B6 field focused', native('half_interstitial'));
  await host.page.locator('#host-field').fill('zz typing');
  await host.track(EVENT);
  await expect(host.message.getByText('zz title half_interstitial')).toBeVisible();
  await host.page.keyboard.press('Escape');
  await expect(host.message).toHaveCount(0);
  // Focus goes back to where the person was typing.
  expect(await host.page.evaluate(() => document.activeElement?.id)).toBe('host-field');
  await host.report(id, (r) => r.views === 1 && r.dismissals === 1);
}

export async function survivesClientNavigation(host: Host) {
  test.skip(host.name === 'plain', 'the plain page navigates with full loads; client-side routing applies to React, Next and Vue');
  const id = await host.show('B10 navigation', native('footer'));
  await host.trigger();
  await expect(host.message.getByText('zz title footer')).toBeVisible();
  await host.page.locator('#host-second').click();
  await expect(host.page.locator('h1')).toHaveText('Second');
  await expect(host.message).toHaveCount(1);
  await expect(host.message.getByText('zz title footer')).toBeVisible();
  await host.page.locator('#host-home').click();
  await expect(host.page.locator('h1')).toHaveText('Host home');
  await expect(host.message).toHaveCount(1);
  expect(await host.maxMessages()).toBe(1);
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await host.report(id, (r) => r.views === 1 && r.clicks === 1);
  await staysAt(host, id, (r) => r.views === 1, 3_000);
}

export async function remountNoDuplicate(host: Host) {
  test.skip(host.name === 'plain', 'the plain page has no component tree to remount');
  const id = await host.show('B10 remount', native('footer'));
  await host.trigger();
  await expect(host.message.getByText('zz title footer')).toBeVisible();
  await host.page.locator('#host-remount').click();
  await expect.poll(() => host.page.evaluate(() => (window as unknown as { __hostMounts: number }).__hostMounts)).toBe(2);
  await expect.poll(() => host.page.evaluate(() => (window as unknown as { __hostConfigured?: boolean }).__hostConfigured)).toBe(true);
  const left = await host.message.count();
  test.info().annotations.push({ type: 'observation', description: `after the remount the message is ${left ? 'still shown' : 'closed'}` });
  expect(left).toBeLessThanOrEqual(1);
  expect(await host.maxMessages()).toBe(1);
  await host.report(id, (r) => r.views === 1);
  await staysAt(host, id, (r) => r.views === 1, 3_000);
}

// MARK: C. Interaction

export async function closeAction(host: Host) {
  const id = await host.show('C11 close', native('interstitial'));
  await host.trigger();
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await expect(host.message).toHaveCount(0);
  await expect.poll(async () => (await host.log()).some((e) => e.cb === 'clicked' && e.id === id)).toBe(true);
  await host.report(id, (r) => r.views === 1 && r.clicks === 1 && r.dismissals === 0);
}

export async function keyValueAction(host: Host) {
  const id = await host.show('C11 key value', native('interstitial'));
  await host.trigger();
  await host.message.getByRole('button', { name: 'zz KV' }).click();
  await expect(host.lastAction).toHaveText('{"zz":"interstitial"}');
  await host.report(id, (r) => r.views === 1 && r.clicks === 1);
}

export async function openUrlAction(host: Host) {
  await stubExample(host);
  const buttons = [{ id: 'go', text: 'zz Go', action: { type: 'open_url', url: `${EXAMPLE}-open` } }];
  const id = await host.show('C11 open url', native('interstitial', { buttons }));
  await host.trigger();
  await host.message.getByRole('button', { name: 'zz Go' }).click();
  // The SDK opens links in the same tab.
  await host.page.waitForURL(`${EXAMPLE}-open`);
  // Delivered as the page unloads, or at the latest when the visitor comes back.
  await host.open('/');
  await host.report(id, (r) => r.views === 1 && r.clicks === 1);
}

export async function appOnlyActionsSkipped(host: Host) {
  const buttons = [{ id: 'rate', text: 'zz Rate', action: { type: 'request_app_rating' } }];
  const id = await host.show('C11 app only action', native('interstitial', { buttons }));
  await host.trigger();
  await host.skipped(id, 'unsupported');
  await expect(host.message).toHaveCount(0);
}

export async function closeButton(host: Host) {
  const id = await host.show('C12 close button', native('interstitial'));
  await host.trigger();
  await host.message.getByRole('button', { name: 'Close' }).click();
  await expect(host.message).toHaveCount(0);
  await expect.poll(async () => (await host.log()).find((e) => e.cb === 'dismissed')?.reason).toBe('close_button');
  await host.report(id, (r) => r.views === 1 && r.dismissals === 1);
}

export async function tapOutsideCloses(host: Host) {
  const id = await host.show('C12 tap outside', native('interstitial'));
  await host.trigger();
  await expect(host.message.getByText('zz title interstitial')).toBeVisible();
  await tapOutside(host);
  await expect(host.message).toHaveCount(0);
  await expect.poll(async () => (await host.log()).find((e) => e.cb === 'dismissed')?.reason).toBe('backdrop');
  await host.report(id, (r) => r.views === 1 && r.dismissals === 1);
}

export async function nonDismissibleStays(host: Host) {
  const id = await host.show('C12 non dismissible', native('interstitial', { dismissible: false }));
  await host.trigger();
  await expect(host.message.getByText('zz title interstitial')).toBeVisible();
  await expect(host.message.getByRole('button', { name: 'Close' })).toHaveCount(0);
  await tapOutside(host);
  await host.page.keyboard.press('Escape');
  await expect(host.message.getByText('zz title interstitial')).toBeVisible();
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await expect(host.message).toHaveCount(0);
  await host.report(id, (r) => r.views === 1 && r.clicks === 1 && r.dismissals === 0);
}

const BRIDGE_PAGE = page(
  '<main style="padding:16px"><h2>zz bridge</h2>' +
    '<button id="b-track" onclick="grovs.track(\'zz_qa_html_evt\',{k:\'v\'})">zz track</button>' +
    '<button id="b-attr" onclick="grovs.setAttribute(\'zz_qa_attr\',\'1\')">zz attr</button>' +
    '<button id="b-close" onclick="grovs.close()">zz close call</button>' +
    '<a id="b-link" href="#" data-grovs-action="close">zz close link</a></main>',
);

export async function htmlBridgeCalls(host: Host) {
  const id = await host.show('C13 bridge', html('modal', BRIDGE_PAGE));
  await host.trigger();
  await expect(host.frame.getByText('zz bridge')).toBeVisible();
  const tracked = host.page.waitForRequest((r) => r.url().endsWith('/events/batch') && (r.postData() ?? '').includes('zz_qa_html_evt'));
  await host.frame.locator('#b-track').click();
  await host.flush();
  await tracked;
  const attribute = host.page.waitForRequest((r) => r.url().endsWith('/visitor_attributes') && (r.postData() ?? '').includes('zz_qa_attr'));
  await host.frame.locator('#b-attr').click();
  await attribute;
  await host.frame.locator('#b-link').click();
  await expect(host.message).toHaveCount(0);
  await host.report(id, (r) => r.views === 1 && r.clicks === 1 && r.dismissals === 1);

  // The script call closes too, on a second showing.
  await host.trigger();
  await expect(host.frame.getByText('zz bridge')).toBeVisible();
  await host.frame.locator('#b-close').click();
  await expect(host.message).toHaveCount(0);
  await host.report(id, (r) => r.views === 2 && r.dismissals === 2);
}

/**
 * `via` is how the message was triggered. app_open shows it 6 s after the load, past the transient user activation
 * Playwright's own navigation and evaluate calls leave; a click on the host shows it at once, inside that window.
 */
export async function htmlOpenOnLoadRefused(host: Host, via: 'app_open' | 'click') {
  await stubExample(host);
  const onLoad = page(`<h2>zz auto open</h2><script>setTimeout(function(){grovs.open('${EXAMPLE}-auto')},300)</script>`);
  const rest = via === 'app_open' ? { triggers: [{ type: 'app_open' }], delay_seconds: 6 } : {};
  const id = await host.show(`C13 open on load ${via}`, html('modal', onLoad, {}, rest), { freshSession: via === 'app_open' });
  if (via === 'click') await host.trigger();
  await expect(host.frame.getByText('zz auto open')).toBeVisible({ timeout: SHOW_TIMEOUT });
  await expect
    .poll(() => host.console.some((line) => line.includes(`open ignored without a tap: ${EXAMPLE}-auto`)) || !host.page.url().startsWith(host.origin))
    .toBe(true);
  expect(host.page.url(), 'the page opened the link on load').toContain(host.origin);
  await host.message.getByRole('button', { name: 'Close' }).click();
  await host.report(id, (r) => r.views === 1 && r.clicks === 0);
}

export async function htmlOpenOnTap(host: Host) {
  await stubExample(host);
  const onTap = page(`<h2>zz tap open</h2><button id="b-open" onclick="grovs.open('${EXAMPLE}-tap')">zz open</button>`);
  const id = await host.show('C13 open on tap', html('modal', onTap));
  await host.trigger();
  await host.frame.locator('#b-open').click();
  await host.page.waitForURL(`${EXAMPLE}-tap`);
  // Delivered as the page unloads, or at the latest when the visitor comes back.
  await host.open('/');
  await host.report(id, (r) => r.views === 1 && r.clicks === 1);
}

export async function starsQuestion(host: Host) {
  const id = await host.show('C14 stars', question('stars'));
  await host.trigger();
  await host.message.getByRole('button', { name: '4 of 5' }).click();
  await host.message.getByRole('textbox', { name: 'zz why' }).fill('zz comment');
  await host.message.getByRole('button', { name: 'Send' }).click();
  await expect(host.message.getByText('zz thanks')).toBeVisible();
  await expect(host.message).toHaveCount(0);
  await expect(host.page.locator('#host-last-answer')).toHaveText('4|zz comment');
  await host.report(id, (r) => r.views === 1 && r.answers === 1);
}

export async function choiceQuestion(host: Host) {
  const id = await host.show('C14 choice', question('choice'));
  await host.trigger();
  await host.message.getByRole('button', { name: 'zz A friend' }).click();
  await expect(host.message.getByText('zz thanks')).toBeVisible();
  await expect(host.message).toHaveCount(0);
  await expect(host.page.locator('#host-last-answer')).toHaveText('friend|');
  await host.report(id, (r) => r.views === 1 && r.answers === 1);
}

export async function htmlVideoPlays(host: Host) {
  const definition: Definition = html('modal', page('<p>zz video pending</p>'));
  const id = await host.show('C15 video', definition, {
    prepare: async (campaign) => {
      const vp9 = await host.backend.uploadMedia(campaign, fixture('clip-vp9.mp4'), 'video/mp4', 'clip-vp9.mp4');
      const h264 = await host.backend.uploadMedia(campaign, fixture('clip-h264.mp4'), 'video/mp4', 'clip-h264.mp4');
      const body = page(
        '<h2>zz video</h2><video id="v" autoplay muted playsinline loop width="160" height="90">' +
          `<source src="${vp9}" type='video/mp4; codecs="vp09.00.10.08"'><source src="${h264}" type="video/mp4"></video>`,
      );
      await host.backend.patch(campaign, { content: { ...(definition['content'] as object), html: body } });
    },
  });
  await host.trigger();
  await expect(host.frame.getByText('zz video')).toBeVisible();
  await expect
    .poll(() => host.frame.locator('#v').evaluate((v: HTMLVideoElement) => v.muted && !v.paused && v.currentTime > 0), { timeout: 20_000 })
    .toBe(true);
  await host.message.getByRole('button', { name: 'Close' }).click();
  await host.report(id, (r) => r.views === 1);
}

export async function htmlNeverReadySkipped(host: Host) {
  // A parser-blocking script that never answers holds DOMContentLoaded, so the page never says ready.
  await host.page.context().route('**/zz-qa-hang.js', () => undefined);
  const hang = new URL('/zz-qa-hang.js', host.origin).toString();
  const id = await host.show('C15 never ready', html('modal', page(`<script src="${hang}"></script><p>zz never</p>`)));
  await host.trigger();
  await expect.poll(() => host.console.some((line) => line.includes(`${id} was not ready within 5 s`)), { timeout: 20_000 }).toBe(true);
  await expect(host.message).toHaveCount(0);
  await staysAt(host, id, (r) => r.views === 0, 3_000);
}

// MARK: D. Rules

export async function appOpenTrigger(host: Host) {
  const id = await host.show('D16 app open', native('interstitial', {}, { triggers: [{ type: 'app_open' }] }), { freshSession: true });
  await expect(host.message.getByText('zz title interstitial')).toBeVisible();
  await expect(host.page.locator('h1')).toHaveText('Host home');
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await expect(host.message).toHaveCount(0);
  // The host stays usable once it is closed.
  await host.page.locator('#host-field').fill('zz usable');
  await host.report(id, (r) => r.views === 1);
  // A load within the same visit is not an opening.
  await host.open('/', { waitFor: true });
  await expect(host.page.locator('h1')).toHaveText('Host home');
  await expect(host.message).toHaveCount(0);
  await staysAt(host, id, (r) => r.views === 1, 3_000);
}

export async function screenViewTrigger(host: Host) {
  const id = await host.show('D16 screen view', native('interstitial', {}, { triggers: [{ type: 'screen_view', name: 'Second' }] }));
  await expect(host.message).toHaveCount(0);
  await host.page.locator('#host-second').click();
  await expect(host.page.locator('h1')).toHaveText('Second');
  await expect(host.message.getByText('zz title interstitial')).toBeVisible();
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await host.report(id, (r) => r.views === 1);
}

export async function eventFilterTrigger(host: Host) {
  const triggers = [{ type: 'event', name: EVENT, filters: [{ field: 'tier', op: 'eq', value: 'gold' }] }];
  const id = await host.show('D16 event filter', native('interstitial', {}, { triggers }));
  await host.track(EVENT, { tier: 'silver' });
  await expect(host.message).toHaveCount(0);
  await host.track(EVENT, { tier: 'gold' });
  await expect(host.message.getByText('zz title interstitial')).toBeVisible();
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await host.report(id, (r) => r.views === 1);
}

export async function sessionCap(host: Host) {
  const id = await host.show('D17 session cap', native('interstitial', {}, { caps: { session: 1 } }));
  await host.trigger();
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await expect(host.message).toHaveCount(0);
  await host.trigger();
  await host.skipped(id, 'cap_session');
  await expect(host.message).toHaveCount(0);
  await host.report(id, (r) => r.views === 1);
}

export async function capAcrossVisits(host: Host, cap: 'day' | 'lifetime') {
  const id = await host.show(`D17 ${cap} cap`, native('interstitial', {}, { caps: { [cap]: 1 } }));
  await host.trigger();
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await host.report(id, (r) => r.views === 1);
  // A new visit: a session cap would allow it again, this one must not.
  const sync = host.page.waitForResponse((r) => r.url().endsWith('/in_app/sync'));
  await host.open('/', { freshSession: true });
  const served = await (await sync).text();
  await host.trigger();
  await expect(host.message).toHaveCount(0);
  // The device skips it, or the server (which counts lifetime views) no longer sends it.
  if (served.includes(`"id":"${id}"`)) await host.skipped(id, `cap_${cap}`);
  else expect(cap).toBe('lifetime');
}

export async function delayedShow(host: Host) {
  const id = await host.show('D17 delay', native('interstitial', {}, { delay_seconds: 3 }));
  const started = Date.now();
  await host.trigger();
  await expect(host.message).toHaveCount(0);
  await expect(host.message.getByText('zz title interstitial')).toBeVisible({ timeout: 20_000 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await host.report(id, (r) => r.views === 1);
}

export async function priorityWins(host: Host) {
  const low = await host.create('D18 priority 1', native('interstitial', { title: 'zz low' }, { priority: 1 }));
  const high = await host.show('D18 priority 5', native('interstitial', { title: 'zz high' }, { priority: 5 }));
  await host.trigger();
  await expect(host.message.getByText('zz high')).toBeVisible();
  await expect(host.message.getByText('zz low')).toHaveCount(0);
  await host.message.getByRole('button', { name: 'zz OK' }).click();
  await expect(host.message).toHaveCount(0);
  await host.report(high, (r) => r.views === 1);
  await staysAt(host, low, (r) => r.views === 0, 2_000);
}
