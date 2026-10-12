/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { expect, test, type Host } from './fixtures';
import { html, native } from './definitions';
import type { Report } from '../live-backend';
import type { Locator } from '@playwright/test';

const fixture = (path: string) => readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8');

/** The dashboard gallery's examples (grovs-web-app ee/lib/inAppHtmlGallery), with a line each shows whatever the layout. */
export const GALLERY = [
  { id: 'promo-video', text: 'Edit videos right on your phone' },
  { id: 'product-launch', text: 'Smart Collections' },
  { id: 'push-primer', text: 'Never miss a price drop' },
  { id: 'countdown-offer', text: '40% off Pro, today only' },
  { id: 'feature-tour', text: 'All your plans in one place' },
  { id: 'feedback', text: 'How are you enjoying the app so far?' },
  { id: 'announcement-banner', text: 'Dark mode is here' },
  { id: 'win-back', text: 'We miss you, friend' },
] as const;

export const RICH = {
  long: fixture('rich/long.html'),
  video: fixture('rich/video.html'),
  broken: fixture('rich/video-broken.html'),
  poster: fixture('rich/poster.html'),
  custom: fixture('rich/custom.html'),
  actions: fixture('rich/actions.html'),
};

const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };
/** One light showing at the desktop size, then one dark showing at a phone's. */
const PASSES = [
  { scheme: 'light', viewport: DESKTOP },
  { scheme: 'dark', viewport: PHONE },
] as const;

export const PORTRAIT = 'https://fastly.picsum.photos/id/1015/1200/2400.jpg?hmac=88xCnyC48FHEuz0qci6zYJdOyRNZ3HgzJTTAswGh5lQ';
export const LANDSCAPE = 'https://www.gstatic.com/webp/gallery/3.jpg';
// 256 and 1024 are the schema's limits; 64 a button label's.
export const LONG_TITLE = `zz-qa long title ${'Wonderful long headline words '.repeat(9)}`.slice(0, 256);
export const LONG_MESSAGE = `zz-qa long message ${'A sentence that keeps going so the body has to wrap many times over. '.repeat(15)}`.slice(0, 1024);
export const LABEL_A = 'zz-qa first button with a label as long as the schema allows it'.padEnd(64, '.').slice(0, 64);
export const LABEL_B = 'zz-qa second button with a label as long as the schema allows it'.padEnd(64, '.').slice(0, 64);
export const COLORS = { background: '#1F2937', title: '#FDE68A', message: '#E5E7EB' };

/** Fails unless the element's box lies wholly within the viewport (half a pixel of rounding allowed). */
async function expectInside(host: Host, element: Locator, what: string) {
  // The card slides 8 px into place over 160 ms; measure where it comes to rest.
  await host.message.locator('.card').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
  const box = await element.boundingBox();
  const viewport = host.page.viewportSize();
  expect(box, `${what} has no box`).not.toBeNull();
  if (!box || !viewport) return;
  const inside = box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= viewport.width + 0.5 && box.y + box.height <= viewport.height + 0.5;
  expect(inside, `${what} ${JSON.stringify(box)} is not inside ${JSON.stringify(viewport)}`).toBe(true);
}

async function expectMessageInside(host: Host) {
  await expectInside(host, host.message.locator('.card'), 'card');
  await expectInside(host, host.message.locator('iframe'), 'frame');
}

const close = (host: Host) => host.message.getByRole('button', { name: 'Close' });

async function closeIt(host: Host) {
  await expect(close(host)).toBeInViewport({ ratio: 1 });
  await close(host).click();
  await expect(host.message).toHaveCount(0);
}

async function shownCount(host: Host, id: string) {
  return (await host.log()).filter((e) => e.cb === 'shown' && e.id === id).length;
}

async function finalReport(host: Host, id: string, until: (r: Report) => boolean, shows: number) {
  expect(await shownCount(host, id), 'onShown calls').toBe(shows);
  expect(await host.maxMessages(), 'messages on the page at once').toBe(1);
  await host.report(id, until);
}

/** The host context sends the linked origin as a header on every request; a CORS fetch elsewhere (a web font) must not carry it. */
async function thirdPartyWithoutOriginHeader(host: Host, pattern: string) {
  await host.page.context().route(pattern, async (route) => {
    const headers = { ...route.request().headers() };
    delete headers['identifier'];
    await route.continue({ headers });
  });
}

/** Whether the frame's element lies wholly inside the frame's own viewport. */
function inFrameView(element: Locator) {
  return element.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
}

// MARK: R1. Gallery designs

export async function galleryDesign(host: Host, design: (typeof GALLERY)[number], layout: string) {
  const id = await host.show(`R1 ${design.id} ${layout}`, html(layout, fixture(`gallery/${design.id}.html`)));
  for (const pass of PASSES) {
    await test.step(`${pass.scheme} ${pass.viewport.width}x${pass.viewport.height}`, async () => {
      await host.page.emulateMedia({ colorScheme: pass.scheme });
      await host.page.setViewportSize(pass.viewport);
      await host.trigger();
      await expect(host.frame.getByText(design.text).first()).toBeVisible();
      await expectMessageInside(host);
      const body = host.frame.locator('body');
      expect(await body.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), 'page colour scheme').toBe(pass.scheme === 'dark');
      // Every design paints its body from --bg: white in light, near black in dark.
      const lightness = await body.evaluate((el) => {
        const [r = 0, g = 0, b = 0] = (getComputedStyle(el).backgroundColor.match(/\d+/g) ?? []).map(Number);
        return (r * 299 + g * 587 + b * 114) / 1000;
      });
      if (pass.scheme === 'dark') expect(lightness, 'dark page background').toBeLessThan(80);
      else expect(lightness, 'light page background').toBeGreaterThan(200);
      await closeIt(host);
    });
  }
  await finalReport(host, id, (r) => r.views === 2 && r.dismissals === 2 && r.clicks === 0, 2);
}

// MARK: R2. Long page

export async function longScroll(host: Host, layout: string) {
  const id = await host.show(`R2 long ${layout}`, html(layout, RICH.long));
  await host.trigger();
  const top = host.frame.getByText('zz-qa long page top');
  await expect(top).toBeVisible();
  await expectMessageInside(host);
  expect(await inFrameView(top), 'the header is not in view at first').toBe(true);
  expect(await host.frame.locator('html').evaluate(() => document.scrollingElement?.scrollTop ?? -1), 'scrolled before anyone scrolled').toBe(0);
  const last = host.frame.locator('#last');
  expect(await inFrameView(last), 'the last button is in view without scrolling; the page is too short for this frame').toBe(false);
  // The wheel over the message scrolls the page inside it.
  const box = await host.message.locator('iframe').boundingBox();
  if (!box) throw new Error('no frame box');
  await host.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 80 && !(await inFrameView(last)); i++) {
    await host.page.mouse.wheel(0, 250);
    await host.page.waitForTimeout(50);
  }
  expect(await inFrameView(last), 'the last button never scrolled into view').toBe(true);
  expect(await host.page.evaluate(() => scrollY), 'the host page scrolled instead').toBe(0);
  const tracked = host.page.waitForRequest((r) => r.url().endsWith('/events/batch') && (r.postData() ?? '').includes('zz_qa_rich_bottom'));
  await last.click();
  await expect(host.frame.getByText('zz-qa bottom tapped')).toBeVisible();
  await host.flush();
  await tracked;
  await expect(host.message).toHaveCount(1);
  // And back up to the header.
  for (let i = 0; i < 80 && !(await inFrameView(top)); i++) {
    await host.page.mouse.wheel(0, -250);
    await host.page.waitForTimeout(50);
  }
  expect(await inFrameView(top), 'the header never scrolled back into view').toBe(true);
  await expect(host.message).toHaveCount(1);
  await closeIt(host);
  await finalReport(host, id, (r) => r.views === 1 && r.clicks === 1 && r.dismissals === 1, 1);
}

// MARK: R3. Video

export async function videoPlays(host: Host) {
  const id = await host.show('R3 video', html('modal', RICH.video));
  await host.trigger();
  await expect(host.frame.getByText('zz-qa video title')).toBeVisible();
  await expect(host.frame.locator('#s'), 'the muted clip never played inline').toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  const video = host.frame.locator('#v');
  expect(await video.evaluate((v: HTMLVideoElement) => ({ muted: v.muted, loop: v.loop, controls: v.controls }))).toEqual({
    muted: true,
    loop: true,
    controls: true,
  });
  // The clip is 5 s long.
  await expect(host.frame.locator('#l'), 'the clip never looped').not.toHaveText('zz-qa loops 0', { timeout: 30_000 });
  await expectMessageInside(host);
  await closeIt(host);
  await finalReport(host, id, (r) => r.views === 1 && r.dismissals === 1, 1);
}

export async function brokenVideo(host: Host) {
  const id = await host.show('R3 broken video', html('modal', RICH.broken));
  await host.trigger();
  await expect(host.frame.getByText('zz-qa the rest of the message still shows')).toBeVisible();
  await expect(host.frame.locator('#s')).toHaveAttribute('data-state', 'error', { timeout: 20_000 });
  await expectMessageInside(host);
  await closeIt(host);
  await finalReport(host, id, (r) => r.views === 1 && r.dismissals === 1, 1);
}

export async function bigPoster(host: Host) {
  const id = await host.show('R3 big poster', html('modal', RICH.poster));
  await host.trigger();
  await expect(host.frame.getByText('zz-qa poster title')).toBeVisible();
  await expect(host.frame.locator('#s')).toHaveText('zz-qa poster loaded 3840', { timeout: 30_000 });
  const video = await host.frame.locator('#v').boundingBox();
  expect(video?.height ?? 0, 'the poster area collapsed').toBeGreaterThan(100);
  await expectMessageInside(host);
  await expect(host.frame.getByRole('button', { name: 'zz-qa poster done' })).toBeVisible();
  await host.frame.getByRole('button', { name: 'zz-qa poster done' }).click();
  await expect(host.message).toHaveCount(0);
  // data-grovs-action="close" is a dismissal, not a click.
  await finalReport(host, id, (r) => r.views === 1 && r.clicks === 0 && r.dismissals === 1, 1);
}

// MARK: R4. Native templates at the limits

export async function nativeAtLimits(host: Host, template: string) {
  // The server holds an alert to 80/300/30 characters.
  const cut = (s: string, n: number) => (template === 'alert' ? s.slice(0, n) : s);
  const title = cut(LONG_TITLE, 80);
  const message = cut(LONG_MESSAGE, 300);
  const labelA = cut(LABEL_A, 30);
  const labelB = cut(LABEL_B, 30);
  const buttons = [
    { id: 'ok', text: labelA, action: { type: 'close' }, colors: { background: '#DC2626', text: '#FFFFFF' } },
    { id: 'kv', text: labelB, action: { type: 'key_value', payload: { zz: 'limits' } }, colors: { background: '#FDE68A', text: '#111827' } },
  ];
  const id = await host.show(`R4 limits ${template}`, native(template, { title, message, buttons, colors: COLORS }));
  for (const [index, pass] of PASSES.entries()) {
    await test.step(`${pass.viewport.width}x${pass.viewport.height}`, async () => {
      await host.page.setViewportSize(pass.viewport);
      await host.trigger();
      const card = host.message.locator('.card');
      await expect(card).toBeVisible();
      await expectInside(host, card, 'card');
      await expect(host.message.getByText(title)).toBeVisible();
      expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor), 'background colour').toBe('rgb(31, 41, 55)');
      expect(await host.message.getByText(title).evaluate((el) => getComputedStyle(el).color), 'title colour').toBe('rgb(253, 230, 138)');
      for (const label of [labelA, labelB]) {
        await expect(host.message.getByRole('button', { name: label }), `${label} on screen`).toBeInViewport({ ratio: 1 });
      }
      if (index === 0) {
        await host.message.getByRole('button', { name: labelA }).click();
      } else {
        await host.message.getByRole('button', { name: labelB }).click();
        await expect(host.lastAction).toHaveText('{"zz":"limits"}');
      }
      await expect(host.message).toHaveCount(0);
    });
  }
  await finalReport(host, id, (r) => r.views === 2 && r.clicks === 2, 2);
}

export async function imageTemplate(host: Host, template: string) {
  const content = { title: null, message: null, buttons: [], image: { portrait: PORTRAIT, landscape: LANDSCAPE } };
  const id = await host.show(`R4 image ${template}`, native(template, content));
  for (const [index, pass] of PASSES.entries()) {
    await test.step(`${pass.viewport.width}x${pass.viewport.height}`, async () => {
      await host.page.setViewportSize(pass.viewport);
      // Shown only once both pictures are loaded, so the trigger repeats until it shows.
      await expect(async () => {
        await host.trigger();
        await expect(host.message).toHaveCount(1, { timeout: 1_000 });
      }).toPass({ timeout: 30_000 });
      const image = host.message.locator('img.media');
      await expect(image).toHaveAttribute('src', index === 0 ? LANDSCAPE : PORTRAIT);
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      await expectInside(host, host.message.locator('.card'), 'card');
      await expectInside(host, image, 'image');
      await closeIt(host);
    });
  }
  await finalReport(host, id, (r) => r.views === 2 && r.dismissals === 2, 2);
}

// MARK: R5. Custom UI

export async function customUi(host: Host, layout: string) {
  await thirdPartyWithoutOriginHeader(host, 'https://fonts.gstatic.com/**');
  const id = await host.show(`R5 custom ${layout}`, html(layout, RICH.custom));
  await host.page.setViewportSize(PHONE);
  await host.trigger();
  await expect(host.frame.getByText('zz-qa custom font')).toBeVisible();
  await expect(host.frame.locator('#font'), 'the https web font did not load').toHaveText('zz-qa font loaded', { timeout: 20_000 });
  await expectMessageInside(host);
  const input = host.frame.locator('#name');
  await input.click();
  await host.page.keyboard.type('zz typed', { delay: 20 });
  await expect(input).toHaveValue('zz typed');
  await expect(host.message, 'typing closed the message').toHaveCount(1);
  await host.frame.getByRole('button', { name: 'zz-qa send' }).click();
  await expect(host.frame.getByText('zz-qa echo zz typed')).toBeVisible();
  await expectMessageInside(host);
  // The page's fixed header sits under the SDK's close control, which must still take the tap.
  await closeIt(host);
  await host.page.locator('#host-field').fill('zz host usable');
  await expect(host.page.locator('#host-field')).toHaveValue('zz host usable');
  await finalReport(host, id, (r) => r.views === 1 && r.clicks === 1 && r.dismissals === 1, 1);
}

// MARK: R6. Every kind of button in a long page, each proven to do its job

const EXAMPLE = 'https://example.com/zz-qa';

async function stubExample(host: Host) {
  await host.page.context().route('https://example.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>zz example</h1>' }),
  );
}

/** Wheels the page inside the message until the element is wholly in the frame's view. */
async function scrollIntoFrameView(host: Host, element: Locator) {
  const box = await host.message.locator('iframe').boundingBox();
  if (!box) throw new Error('no frame box');
  await host.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 120; i++) {
    // As far as the element is out of view plus a margin, at most 300 px a turn.
    const delta = await element.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const by = r.top < 0 ? r.top - 16 : r.bottom > window.innerHeight ? r.bottom - window.innerHeight + 16 : 0;
      return Math.max(-300, Math.min(300, Math.round(by)));
    });
    if (delta === 0) return;
    await host.page.mouse.wheel(0, delta);
    await host.page.waitForTimeout(40);
  }
  throw new Error('the element never scrolled into the frame');
}

async function tapInFrame(host: Host, element: Locator) {
  await scrollIntoFrameView(host, element);
  await element.click();
}

async function callbacks(host: Host, id: string, cb: string) {
  return (await host.log()).filter((e) => e.cb === cb && e.id === id);
}

/** Exactly one event of that name from this visitor reaches the backend, with these properties. */
async function expectEventOnce(host: Host, name: string, properties: Record<string, unknown>) {
  await host.flush().catch(() => undefined);
  await expect.poll(async () => (await host.backend.events(name, host.state.identifier)).length, { timeout: 60_000, message: `${name} never reached the backend` }).toBeGreaterThanOrEqual(1);
  // A duplicate sent a moment later would show here.
  await host.page.waitForTimeout(3_000);
  const rows = await host.backend.events(name, host.state.identifier);
  expect(rows.length, `${name} events`).toBe(1);
  expect(await host.backend.eventProperties(rows[0]!.event_id), `${name} properties`).toMatchObject(properties);
}

export function actionsTag(host: Host, layout: string) {
  return `${host.state.identifier}_${layout}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

export async function actionsPage(host: Host, layout: string) {
  await stubExample(host);
  const tag = actionsTag(host, layout);
  const id = await host.show(`R6 actions ${layout}`, html(layout, RICH.actions.split('TAG').join(tag)));
  const f = host.frame;
  await test.step('track, setAttribute, push, in-page link, end of page, close by attribute', async () => {
    await host.trigger();
    await expect(f.getByText('zz-qa actions top')).toBeVisible();
    await expectMessageInside(host);
    await tapInFrame(host, f.locator('#b-track1'));
    await expect(f.locator('#s-track1')).toHaveText('zz-qa did track one');
    await expect.poll(async () => (await callbacks(host, id, 'clicked')).length, { message: 'onClicked for the page track' }).toBe(1);
    await tapInFrame(host, f.locator('#b-attr'));
    await expect(f.locator('#s-attr')).toHaveText('zz-qa did set attribute');
    await tapInFrame(host, f.locator('#b-push'));
    // The web has no push prompt; the page is answered all the same.
    await expect(f.locator('#s-push')).toHaveText('zz-qa push unsupported');
    await tapInFrame(host, f.locator('#b-jump'));
    await expect.poll(() => inFrameView(f.getByText('zz-qa jump target')), { message: 'the in-page link did not scroll' }).toBe(true);
    await expect(host.message, 'a button that does not close closed the message').toHaveCount(1);
    // Still scrolls after those taps, and the last element is wholly visible at the end.
    await scrollIntoFrameView(host, f.locator('#end'));
    await expectMessageInside(host);
    expect(await inFrameView(f.locator('#end')), 'the end of the page is cut off').toBe(true);
    await tapInFrame(host, f.locator('#b-close-data'));
    await expect(host.message).toHaveCount(0);
    expect((await callbacks(host, id, 'dismissed')).map((e) => e.reason)).toEqual(['close_button']);
  });
  await test.step('track by attribute mid-page, then grovs.close()', async () => {
    await host.trigger();
    await expect(f.getByText('zz-qa actions top')).toBeVisible();
    expect(await f.locator('html').evaluate(() => document.scrollingElement?.scrollTop ?? -1), 'a new showing starts scrolled').toBe(0);
    await tapInFrame(host, f.locator('#b-track2'));
    await expect(f.locator('#s-track2')).toHaveText('zz-qa did track two');
    await tapInFrame(host, f.locator('#b-close-js'));
    await expect(host.message).toHaveCount(0);
  });
  for (const [selector, url] of [
    ['#b-open-js', `${EXAMPLE}-open-js`],
    ['#b-open-data', `${EXAMPLE}-open-data`],
    ['#b-link', `${EXAMPLE}-link`],
  ] as const) {
    await test.step(`${selector} opens ${url}`, async () => {
      await host.trigger();
      await expect(f.getByText('zz-qa actions top')).toBeVisible();
      await scrollIntoFrameView(host, f.locator(selector));
      await Promise.all([host.page.waitForURL(url), f.locator(selector).click()]);
      // Delivered as the page unloads, or at the latest when the visitor comes back.
      await host.open('/', { waitFor: id });
    });
  }
  await expectEventOnce(host, `zz_qa_rich_1_${tag}`, { n: 1, where: 'top', ok: true, campaign_id: id });
  await expectEventOnce(host, `zz_qa_rich_2_${tag}`, { campaign_id: id });
  await expect.poll(async () => (await host.backend.visitorAttributes(host.state.visitor))['zz_qa_attr'], { timeout: 30_000 }).toBe(tag);
  // One click a showing (the first track or open), two closes, no button ids.
  await host.report(id, (r) => r.views === 5 && r.clicks === 5 && r.dismissals === 2 && r.buttons[''] === 5);
}

// MARK: R7. Native buttons of every action type

export const PAYLOAD = { a: '1', b: 'two words', c: 'ünïcødé ✓', d: 'x=y&z', e: '{"json":true}' };

export async function nativeActions(host: Host, template: string) {
  await stubExample(host);
  const closeUrl = await host.show(
    `R7 ${template} close url`,
    native(template, {
      buttons: [
        { id: 'close', text: 'zz-qa close', action: { type: 'close' } },
        { id: 'url', text: 'zz-qa open', action: { type: 'open_url', url: `${EXAMPLE}-native` } },
      ],
    }),
  );
  await host.trigger();
  await host.message.getByRole('button', { name: 'zz-qa close' }).click();
  await expect(host.message).toHaveCount(0);
  expect((await callbacks(host, closeUrl, 'clicked')).map((e) => (e as { button?: string }).button)).toEqual(['close']);
  await host.trigger();
  await Promise.all([host.page.waitForURL(`${EXAMPLE}-native`), host.message.getByRole('button', { name: 'zz-qa open' }).click()]);
  await host.open('/', { waitFor: closeUrl });
  await host.report(closeUrl, (r) => r.views === 2 && r.clicks === 2 && r.buttons['close'] === 1 && r.buttons['url'] === 1);
  await host.backend.cleanUp(closeUrl);

  const keyValue = await host.show(
    `R7 ${template} key value`,
    native(template, {
      buttons: [
        { id: 'kv', text: 'zz-qa key value', action: { type: 'key_value', payload: PAYLOAD } },
        { id: 'done', text: 'zz-qa done', action: { type: 'close' } },
      ],
    }),
  );
  await host.trigger();
  await host.message.getByRole('button', { name: 'zz-qa key value' }).click();
  await expect(host.message).toHaveCount(0);
  // React, Next and Vue render the callback's text a moment later.
  await expect(host.lastAction).not.toHaveText('');
  expect(JSON.parse((await host.lastAction.textContent()) ?? '{}'), 'key_value payload in the host callback').toEqual(PAYLOAD);
  await host.trigger();
  await host.message.getByRole('button', { name: 'zz-qa done' }).click();
  await expect(host.message).toHaveCount(0);
  expect((await callbacks(host, keyValue, 'clicked')).map((e) => (e as { button?: string }).button)).toEqual(['kv', 'done']);
  await host.report(keyValue, (r) => r.views === 2 && r.clicks === 2 && r.buttons['kv'] === 1 && r.buttons['done'] === 1);
  await host.backend.cleanUp(keyValue);

  // Push, rating and the store need an app: the web skips such a message rather than show dead buttons.
  for (const buttons of [
    [
      { id: 'push', text: 'zz-qa push', action: { type: 'request_push_permission' } },
      { id: 'rate', text: 'zz-qa rate', action: { type: 'request_app_rating' } },
    ],
    [{ id: 'store', text: 'zz-qa store', action: { type: 'open_store' } }],
  ]) {
    const id = await host.show(`R7 ${template} ${buttons[0]!.id}`, native(template, { buttons }));
    await host.trigger();
    await host.skipped(id, 'unsupported');
    await expect(host.message).toHaveCount(0);
    await host.backend.cleanUp(id);
  }
}
