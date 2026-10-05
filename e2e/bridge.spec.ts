import { expect, test, type Frame, type Page } from '@playwright/test';

/** The copied bridge.js in a real sandboxed srcdoc frame, with bridge-harness.html as the platform. */

type Json = Record<string, unknown>;
interface Post {
  message: { v: number; token: string; id: string; type: string; args: Json };
  snapshot: string | null;
}
interface Options {
  user?: Json;
  event?: Json;
  capabilities?: Json;
  height?: number;
  noResizeObserver?: boolean;
  noFrames?: boolean;
}

declare global {
  interface Window {
    posts: Post[];
    harnessReady: boolean;
    mount: (html: string, options?: Options) => void;
    reply: (message: Json) => void;
    grovs: {
      close(): void;
      track(name: string, properties?: Json): void;
      open(url: string): void;
      setAttribute(key: string, value: unknown): void;
      requestPushPermission(): Promise<string>;
      user: Json;
      event: Json;
      capabilities: Json;
    };
    __grovs?: unknown;
    __grovsReply: (message: Json) => void;
    seen: unknown;
    outcome: unknown;
  }
}

const PAGE = '<!doctype html><html><head></head><body><p id="t">Hello</p></body></html>';

async function mount(page: Page, html: string, options: Options = {}, before?: () => Promise<unknown>): Promise<Frame> {
  await page.goto('/e2e/bridge-harness.html');
  await before?.();
  await page.waitForFunction(() => window.harnessReady === true);
  await page.evaluate(([h, o]) => window.mount(h, o), [html, options] as const);
  await expect.poll(() => types(page)).toContain('ready');
  const frame = page.frame({ name: 'message' });
  if (!frame) throw new Error('message frame missing');
  return frame;
}

const posts = (page: Page): Promise<Post[]> => page.evaluate(() => window.posts);
const types = async (page: Page): Promise<string[]> => (await posts(page)).map((post) => post.message.type);
const calls = async (page: Page): Promise<Post['message'][]> =>
  (await posts(page)).map((post) => post.message).filter((message) => message.type !== 'ready' && message.type !== 'height');
const ready = async (page: Page): Promise<Post> => {
  const found = (await posts(page)).find((post) => post.message.type === 'ready');
  if (!found) throw new Error('no ready');
  return found;
};
const heights = async (page: Page): Promise<number[]> =>
  (await posts(page)).filter((post) => post.message.type === 'height').map((post) => post.message.args['value'] as number);
const settle = (frame: Frame): Promise<void> =>
  frame.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))));

test.describe('public API', () => {
  test('every call posts a v1 envelope with the token and a fresh id', async ({ page }) => {
    const frame = await mount(page, PAGE);
    await frame.evaluate(() => {
      window.grovs.close();
      window.grovs.track('liked', { stars: 5 });
      window.grovs.track('plain');
      window.grovs.open('https://example.com/a');
      window.grovs.setAttribute('plan', 'pro');
      void window.grovs.requestPushPermission();
    });
    await expect.poll(async () => (await calls(page)).length).toBe(6);
    const sent = await calls(page);
    for (const message of sent) {
      expect(message.v).toBe(1);
      expect(message.token).toBe('T0K3N');
      expect(typeof message.id).toBe('string');
    }
    const all = await posts(page);
    expect(new Set(all.map((post) => post.message.id)).size).toBe(all.length);
    expect(sent.map(({ type, args }) => ({ type, args }))).toEqual([
      { type: 'close', args: {} },
      { type: 'track', args: { name: 'liked', properties: { stars: 5 } } },
      { type: 'track', args: { name: 'plain', properties: {} } },
      { type: 'open', args: { url: 'https://example.com/a', active: expect.any(Boolean) } },
      { type: 'setAttribute', args: { key: 'plan', value: 'pro' } },
      { type: 'requestPushPermission', args: {} },
    ]);
  });

  test('open sends the frame\'s own activation, which the page cannot fake', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox lends the host page\'s activation to frames');
    test.skip(!(await page.evaluate(() => 'userActivation' in navigator)), 'no navigator.userActivation');
    await mount(
      page,
      '<!doctype html><script>Object.defineProperty(UserActivation.prototype, "isActive", { get: function () { return true; } });' +
        'setTimeout(function () { grovs.open("https://example.com/auto"); }, 300)</script>',
    );
    await expect.poll(async () => (await calls(page)).map(({ type, args }) => ({ type, args }))).toEqual([
      { type: 'open', args: { url: 'https://example.com/auto', active: false } },
    ]);
  });

  test('grovs is frozen, its user, event and capabilities are frozen copies, and __grovs is gone', async ({ page }) => {
    const frame = await mount(page, PAGE, {
      user: { name: 'Ana' },
      event: { sku: 'A1' },
      capabilities: { pushPermission: 'denied' },
    });
    const state = await frame.evaluate(() => {
      const before = window.grovs;
      const attempts = [
        () => ((window as unknown as Json)['grovs'] = 1),
        () => delete (window as unknown as Json)['grovs'],
        () => Object.defineProperty(window, 'grovs', { value: 2 }),
      ];
      for (const attempt of attempts) {
        try {
          attempt();
        } catch {
          // read-only and non-configurable: strict mode throws, which is fine
        }
      }
      return {
        same: window.grovs === before,
        frozen: Object.isFrozen(window.grovs),
        user: Object.isFrozen(window.grovs.user) && window.grovs.user['name'],
        event: Object.isFrozen(window.grovs.event) && window.grovs.event['sku'],
        push: Object.isFrozen(window.grovs.capabilities) && window.grovs.capabilities['pushPermission'],
        platform: '__grovs' in window,
      };
    });
    expect(state).toEqual({ same: true, frozen: true, user: 'Ana', event: 'A1', push: 'denied', platform: false });
  });

  test('grovs.user is defined before an inline author script runs', async ({ page }) => {
    const frame = await mount(page, '<!doctype html><script>window.seen = grovs.user.name;</script><p>x</p>', {
      user: { name: 'Ana' },
    });
    expect(await frame.evaluate(() => window.seen)).toBe('Ana');
  });

  test('requestPushPermission resolves with the reply result', async ({ page }) => {
    const frame = await mount(page, PAGE);
    await frame.evaluate(() => {
      window.grovs.requestPushPermission().then(
        (value) => (window.outcome = { value }),
        (error: Error) => (window.outcome = { error: error.message }),
      );
    });
    await expect.poll(async () => (await calls(page)).length).toBe(1);
    const [request] = await calls(page);
    await page.evaluate((id) => window.reply({ v: 1, id, ok: true, result: 'granted' }), request?.id);
    await expect.poll(() => frame.evaluate(() => window.outcome)).toEqual({ value: 'granted' });
  });

  test('requestPushPermission rejects on a not_shown reply', async ({ page }) => {
    const frame = await mount(page, PAGE);
    await frame.evaluate(() => {
      window.grovs.requestPushPermission().then(
        (value) => (window.outcome = { value }),
        (error: Error) => (window.outcome = { error: error.message }),
      );
    });
    await expect.poll(async () => (await calls(page)).length).toBe(1);
    const [request] = await calls(page);
    await page.evaluate((id) => window.reply({ v: 1, id, ok: false, error: 'not_shown' }), request?.id);
    await expect.poll(() => frame.evaluate(() => window.outcome)).toEqual({ error: 'not_shown' });
  });

  test('__grovsReply answers too (the iOS path)', async ({ page }) => {
    const frame = await mount(page, PAGE);
    await frame.evaluate(() => {
      window.outcome = [];
      window.grovs.requestPushPermission().then((value) => (window.outcome as unknown[]).push(value));
    });
    await expect.poll(async () => (await calls(page)).length).toBe(1);
    const [request] = await calls(page);
    await frame.evaluate((id) => window.__grovsReply({ v: 1, id, ok: true, result: 'denied' }), request?.id);
    await frame.evaluate((id) => window.__grovsReply({ v: 1, id, ok: true, result: 'granted' }), request?.id);
    await expect.poll(() => frame.evaluate(() => window.outcome)).toEqual(['denied']);
    const replaced = await frame.evaluate(() => {
      try {
        (window as unknown as Json)['__grovsReply'] = null;
      } catch {
        // read-only
      }
      return typeof window.__grovsReply;
    });
    expect(replaced).toBe('function');
  });

  test('a reply resolves only the matching id, ignores wrong versions, the page itself and child frames', async ({ page }) => {
    const frame = await mount(page, PAGE);
    await frame.evaluate(() => {
      window.outcome = [];
      const record = (tag: string) => (value: unknown) => (window.outcome as unknown[]).push([tag, value]);
      window.grovs.requestPushPermission().then(record('a'), (error: Error) => record('a!')(error.message));
      window.grovs.requestPushPermission().then(record('b'), (error: Error) => record('b!')(error.message));
    });
    await expect.poll(async () => (await calls(page)).length).toBe(2);
    const [first, second] = await calls(page);
    await frame.evaluate((id) => window.postMessage({ v: 1, id, ok: true, result: 'self' }, '*'), first?.id);
    await page.evaluate((id) => window.reply({ v: 2, id, ok: true, result: 'v2' }), first?.id);
    await page.evaluate((id) => window.reply({ v: 1, id, ok: true, result: 'granted' }), second?.id);
    await expect.poll(() => frame.evaluate(() => window.outcome)).toEqual([['b', 'granted']]);
    await frame.evaluate((id) => {
      const child = document.createElement('iframe');
      child.srcdoc = `<script>parent.postMessage(${JSON.stringify({ v: 1, id, ok: true, result: 'child' })}, '*');</` + 'script>';
      document.body.append(child);
      return new Promise((resolve) => child.addEventListener('load', resolve));
    }, first?.id);
    await settle(frame);
    expect(await frame.evaluate(() => window.outcome)).toEqual([['b', 'granted']]);
    await page.evaluate((id) => window.reply({ v: 1, id, ok: false, error: 'unsupported' }), first?.id);
    await expect.poll(() => frame.evaluate(() => window.outcome)).toEqual([
      ['b', 'granted'],
      ['a!', 'unsupported'],
    ]);
  });
});

test.describe('declarative actions', () => {
  const html =
    '<!doctype html><button id="c" data-grovs-action="close">x</button>' +
    '<button id="o" data-grovs-action="open" data-grovs-url="myapp://deal"><span id="inner">Go</span></button>' +
    '<div id="t" data-grovs-action="track" data-grovs-event="liked">Like</div>' +
    '<a id="a" href="https://example.com/link" data-grovs-action="close">No thanks</a>' +
    '<a id="u" href="https://example.com/unknown" data-grovs-action="later">Unknown</a>' +
    '<div data-grovs-action="later"><a id="ui" href="https://example.com/inner">Inner</a></div>';

  test('close, open and track wire the click, including on a child element', async ({ page }) => {
    const frame = await mount(page, html);
    await frame.click('#c');
    await frame.click('#inner');
    await frame.click('#t');
    await expect.poll(async () => (await calls(page)).map(({ type, args }) => ({ type, args }))).toEqual([
      { type: 'close', args: {} },
      { type: 'open', args: { url: 'myapp://deal', active: true } },
      { type: 'track', args: { name: 'liked', properties: {} } },
    ]);
  });

  test('a link with data-grovs-action runs only its action and does not navigate', async ({ page }) => {
    const frame = await mount(page, html);
    await frame.evaluate(() => (window.seen = 'still here'));
    await frame.click('#a');
    await settle(frame);
    expect((await calls(page)).map((call) => call.type)).toEqual(['close']);
    expect(await frame.evaluate(() => [window.seen, location.href])).toEqual(['still here', 'about:srcdoc']);
  });

  test('an unknown action on or around a link does nothing and does not navigate', async ({ page }) => {
    const frame = await mount(page, html, {}, () =>
      page.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: 'navigated' })),
    );
    await frame.evaluate(() => (window.seen = 'still here'));
    await frame.click('#u');
    await frame.click('#ui');
    await settle(frame);
    expect(await calls(page)).toEqual([]);
    expect(await frame.evaluate(() => [window.seen, location.href])).toEqual(['still here', 'about:srcdoc']);
  });
});

test.describe('plain links', () => {
  const html =
    '<!doctype html><a id="plain" href="https://example.com/x?a=1">Plain</a>' +
    '<a id="frag" href="#more">More</a><a id="spaced" href="  #more">More</a>' +
    '<a id="own" href="https://example.com/own">Own</a>' +
    '<a id="delegated" href="https://example.com/delegated"><b id="deep">Delegated</b></a>' +
    '<img id="map" usemap="#m" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">' +
    '<map name="m"><area shape="rect" coords="0,0,40,40" href="https://example.com/area"></map>' +
    '<a id="tabbed" href=" #mo%72e\t">Tabbed</a>' +
    '<p id="more">more</p>' +
    '<script>document.getElementById("own").addEventListener("click", function (e) { e.preventDefault(); });' +
    'document.addEventListener("click", function (e) { if (e.target.closest("#delegated")) e.preventDefault(); });</script>';

  test('a plain link click becomes open with the raw href', async ({ page }) => {
    const frame = await mount(page, html);
    await frame.click('#plain');
    await expect.poll(() => calls(page)).toHaveLength(1);
    const [call] = await calls(page);
    expect({ type: call?.type, args: call?.args }).toEqual({ type: 'open', args: { url: 'https://example.com/x?a=1', active: true } });
    expect(await frame.evaluate(() => document.getElementById('plain') !== null)).toBe(true);
  });

  // A srcdoc frame inherits the host page's base URL, so the browser would load the host page for "#more".
  test('a #fragment link scrolls in-page without navigating and is not opened', async ({ page }) => {
    const frame = await mount(page, html.replace('<p id="more">', '<p id="more" style="margin-top:2000px">'));
    await frame.evaluate(() => (window.seen = 'still here'));
    for (const link of ['#frag', '#spaced', '#tabbed']) {
      await frame.evaluate(() => window.scrollTo(0, 0));
      await frame.click(link);
      await settle(frame);
      expect(await frame.evaluate(() => [window.seen, location.href, window.scrollY > 1000])).toEqual([
        'still here',
        'about:srcdoc',
        true,
      ]);
    }
    expect(await calls(page)).toEqual([]);
  });

  test('a fragment matches an id, else only an <a name>', async ({ page }) => {
    const frame = await mount(
      page,
      '<!doctype html><a id="named" href="#anchor">Named</a><p name="anchor">not this</p>' +
        '<a name="anchor" style="display:block;margin-top:2000px">this</a>',
    );
    await frame.click('#named');
    await settle(frame);
    expect(await frame.evaluate(() => [location.href, window.scrollY > 1500])).toEqual(['about:srcdoc', true]);
  });

  test('a link inside an open shadow root becomes open', async ({ page }) => {
    const frame = await mount(
      page,
      '<!doctype html><div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" })' +
        '.innerHTML = \'<a id="shadow" href="https://example.com/shadow">Shadow</a>\';</script>',
    );
    await frame.locator('#shadow').click();
    await expect.poll(async () => (await calls(page)).map(({ type, args }) => ({ type, args }))).toEqual([
      { type: 'open', args: { url: 'https://example.com/shadow', active: true } },
    ]);
  });

  test('an <area href> click becomes open', async ({ page }) => {
    const frame = await mount(page, html);
    await frame.click('#map');
    await expect.poll(async () => (await calls(page)).map(({ type, args }) => ({ type, args }))).toEqual([
      { type: 'open', args: { url: 'https://example.com/area', active: true } },
    ]);
  });

  test('a # or #top link scrolls to the top', async ({ page }) => {
    const frame = await mount(
      page,
      '<!doctype html><div style="height:3000px"></div><a id="up" href="#top">Top</a><a id="bare" href="#">Bare</a>',
    );
    for (const link of ['#up', '#bare']) {
      await frame.evaluate(() => window.scrollTo(0, 2500));
      await frame.click(link);
      await settle(frame);
      expect(await frame.evaluate(() => [location.href, window.scrollY])).toEqual(['about:srcdoc', 0]);
    }
    expect(await calls(page)).toEqual([]);
  });

  test('preventDefault in an element handler or a delegated document handler wins', async ({ page }) => {
    const frame = await mount(page, html);
    await frame.click('#own');
    await frame.click('#deep');
    await settle(frame);
    expect(await calls(page)).toEqual([]);
  });
});

test.describe('placeholders', () => {
  test('fills text, alt and data-* from user and event values, with defaults', async ({ page }) => {
    const frame = await mount(
      page,
      '<!doctype html><h1 id="h">Hi {{ user.name }}, {{user.city|default:"there"}}!</h1>' +
        '<p id="e">{{ event.sku }} x {{ user.count }} {{ user.vip }} {{ user.blank | default: "none" }}</p>' +
        '<img id="i" alt="Photo of {{ user.name }}" title="{{ user.missing | default: &quot;guest&quot; }}" data-x="{{ event.sku }}">' +
        '<input id="n" value="{{ user.name }}" placeholder="{{ user.name }}" aria-label="for {{ user.name }}">',
      { user: { name: 'Ana', count: 3, vip: true, blank: '' }, event: { sku: 'A1' } },
    );
    const filled = await frame.evaluate(() => {
      const el = (id: string) => document.getElementById(id) as HTMLElement;
      const img = el('i');
      const input = el('n');
      return {
        h: el('h').textContent,
        e: el('e').textContent,
        alt: img.getAttribute('alt'),
        title: img.getAttribute('title'),
        data: img.getAttribute('data-x'),
        value: input.getAttribute('value'),
        placeholder: input.getAttribute('placeholder'),
        aria: input.getAttribute('aria-label'),
      };
    });
    expect(filled).toEqual({
      h: 'Hi Ana, there!',
      e: 'A1 x 3 true none',
      alt: 'Photo of Ana',
      title: 'guest',
      data: 'A1',
      value: 'Ana',
      placeholder: 'Ana',
      aria: 'for Ana',
    });
    expect((await ready(page)).message.args).toEqual({ missing: false });
  });

  test('numbers read as the SDK engines print them, never in exponent form', async ({ page }) => {
    const frame = await mount(page, '<!doctype html><p id="p">{{ user.big }} {{ user.tiny }} {{ user.zero }} {{ user.half }}</p>', {
      user: { big: 1.5e21, tiny: 1e-7, zero: -0, half: 0.5 },
    });
    expect(await frame.evaluate(() => document.getElementById('p')?.textContent)).toBe('1500000000000000000000 0.0000001 0 0.5');
  });

  test('never fills scripts, style, template, textarea, URLs, srcdoc, style or on* attributes', async ({ page }) => {
    const field = '{{ user.name }}';
    const frame = await mount(
      page,
      `<!doctype html><style id="st">/* ${field} */</style>` +
        `<script id="sc">window.seen = "${field}";</script>` +
        `<template id="tp"><p>${field}</p></template><textarea id="ta">${field}</textarea>` +
        `<a id="a" href="https://example.com/${field}" style="--x: '${field}'" onclick="void '${field}'">link</a>` +
        `<iframe id="f" srcdoc="<p>${field}</p>"></iframe><img id="i" src="https://example.com/${field}.png">` +
        `<button id="b" data-grovs-action="open" data-grovs-url="https://example.com/${field}">b</button>`,
      { user: { name: 'Ana' } },
    );
    const kept = await frame.evaluate(() => {
      const el = (id: string) => document.getElementById(id) as HTMLElement;
      return [
        el('st').textContent,
        el('sc').textContent,
        window.seen,
        (el('tp') as HTMLTemplateElement).content.textContent,
        el('ta').textContent,
        el('a').getAttribute('href'),
        el('a').getAttribute('style'),
        el('a').getAttribute('onclick'),
        el('f').getAttribute('srcdoc'),
        el('i').getAttribute('src'),
        el('b').getAttribute('data-grovs-url'),
      ];
    });
    for (const value of kept) expect(value).toContain('{{ user.name }}');
  });

  test('a script holding {{ that is not a field does not stop the message', async ({ page }) => {
    const frame = await mount(page, '<!doctype html><script>window.seen = "{{ x }}";</script><p id="p">{{ user.name }}</p>', {
      user: { name: 'Ana' },
    });
    expect(await frame.evaluate(() => [window.seen, document.getElementById('p')?.textContent])).toEqual(['{{ x }}', 'Ana']);
    expect((await ready(page)).message.args).toEqual({ missing: false });
  });

  test('a field with no value and no default posts ready missing and fills nothing', async ({ page }) => {
    for (const user of [{}, { name: null }, { name: '' }, { name: { nested: 1 } }]) {
      const frame = await mount(page, '<!doctype html><p id="a">{{ user.city }}</p><p id="b" title="{{ user.name }}">x</p>', {
        user: { city: 'Paris', ...user },
      });
      expect((await ready(page)).message.args).toEqual({ missing: true });
      expect(await frame.evaluate(() => document.getElementById('a')?.textContent)).toBe('{{ user.city }}');
    }
  });

  test('ready is posted once, at DOMContentLoaded, after the fill, before an image loads', async ({ page }) => {
    const frame = await mount(
      page,
      '<!doctype html><p>Hi {{ user.name }}</p><img src="https://images.test/never.png" width="10" height="10">',
      { user: { name: 'Ana' } },
      () => page.route('**/never.png', () => undefined),
    );
    const all = await posts(page);
    expect(all.filter((post) => post.message.type === 'ready')).toHaveLength(1);
    expect((await ready(page)).snapshot ?? '').toContain('<p>Hi Ana</p>');
    expect(await frame.evaluate(() => document.readyState)).toBe('interactive');
  });
});

test.describe('height', () => {
  const html =
    '<!doctype html><html><head><style>html,body{margin:0}</style></head><body><div id="box" style="height:120px"></div></body></html>';
  const resize = (frame: Frame, height: string) =>
    frame.evaluate((value) => ((document.getElementById('box') as HTMLElement).style.height = value), height);

  test('posts the content height once laid out', async ({ page }) => {
    await mount(page, html);
    await expect.poll(() => heights(page)).toEqual([120]);
  });

  test('posts whenever the rounded-up height changes, and only then', async ({ page }) => {
    const frame = await mount(page, html);
    await expect.poll(() => heights(page)).toEqual([120]);
    await resize(frame, '120.6px');
    await expect.poll(() => heights(page)).toEqual([120, 121]);
    await resize(frame, '120.9px');
    await settle(frame);
    expect(await heights(page)).toEqual([120, 121]);
    await resize(frame, '90px');
    await expect.poll(() => heights(page)).toEqual([120, 121, 90]);
  });

  test('changes spread over several tasks post at most once per frame', async ({ page }) => {
    const frame = await mount(page, html);
    await expect.poll(() => heights(page)).toEqual([120]);
    const raf = await frame.evaluate(
      () =>
        new Promise<{ calls: number; maxPending: number }>((resolve) => {
          const stats = { calls: 0, maxPending: 0 };
          let pending = 0;
          const original = window.requestAnimationFrame.bind(window);
          window.requestAnimationFrame = (callback) => {
            stats.calls += 1;
            stats.maxPending = Math.max(stats.maxPending, ++pending);
            return original((time) => {
              pending -= 1;
              callback(time);
            });
          };
          const box = document.getElementById('box') as HTMLElement;
          const steps = ['150px', '170px', '200px'];
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            box.style.height = steps.shift() as string;
            void box.offsetHeight;
            if (steps.length) channel.port2.postMessage(null);
            else original(() => original(() => original(() => resolve(stats))));
          };
          original(() => channel.port2.postMessage(null));
        }),
    );
    await settle(frame);
    const after = (await heights(page)).slice(1);
    expect(after[after.length - 1]).toBe(200);
    expect(raf.maxPending).toBe(1);
    expect(after.length).toBeLessThanOrEqual(raf.calls);
  });

  test('fractional heights are rounded up', async ({ page }) => {
    await mount(page, html.replace('120px', '80.4px'));
    await expect.poll(() => heights(page)).toEqual([81]);
  });

  test('a hidden page whose frames never run still reports its height', async ({ page }) => {
    await mount(page, html, { noFrames: true });
    await expect.poll(() => heights(page)).toEqual([120]);
  });

  test('without ResizeObserver, posts at ready and again at load', async ({ page }) => {
    const frame = await mount(
      page,
      html.replace(
        '</body>',
        '<script>document.addEventListener("DOMContentLoaded", function () { document.getElementById("box").style.height = "150px"; });</script></body>',
      ),
      { noResizeObserver: true },
    );
    expect(await frame.evaluate(() => typeof window.ResizeObserver)).toBe('undefined');
    await expect.poll(() => heights(page)).toEqual([120, 150]);
    expect((await posts(page)).map((post) => post.message.type)).toEqual(['ready', 'height', 'height']);
  });
});

test('injected after the doctype, the page stays in standards mode', async ({ page }) => {
  const frame = await mount(page, '<!DOCTYPE html>\n<html><body><p>x</p></body></html>');
  expect(await frame.evaluate(() => document.compatMode)).toBe('CSS1Compat');
});
