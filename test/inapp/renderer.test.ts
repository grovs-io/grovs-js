import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../../src/logging/logger';
import { readCampaign } from '../../src/inapp/definition';
import type { Outcome } from '../../src/inapp/controller';
import { InAppRenderer } from '../../src/inapp/renderer';
import type { Rendered } from '../../src/inapp/types';
import { merge, readJson } from './shared';

type Json = Record<string, unknown>;

const BASE = readJson('cases.json').base_campaign as Json;
const IMAGE = { portrait: 'https://cdn.example/p.png', landscape: 'https://cdn.example/l.png' };

function open(changes: Json, rendered: Partial<Rendered> = {}) {
  const campaign = readCampaign(merge(BASE, changes));
  if (!campaign) throw new Error('campaign did not read');
  const visited: string[] = [];
  const renderer = new InAppRenderer(document, new Logger(), (url) => visited.push(url));
  const outcome: { value: Outcome | null } = { value: null };
  void renderer
    .present({ campaign, rendered: { title: 'Hello', message: 'Welcome', buttons: [], urls: [], ...rendered } })
    .then((value) => {
      outcome.value = value;
    });
  const root = document.getElementById('grovs-in-app')?.shadowRoot;
  if (!root) throw new Error('nothing was drawn');
  return { renderer, root, outcome, visited };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('InAppRenderer', () => {
  it('draws the title and message as text, never as markup', () => {
    const { root } = open({}, { title: '<img src=x onerror=alert(1)>', message: '<b>bold</b>' });
    expect(root.querySelector('.title')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(root.querySelector('.message')?.textContent).toBe('<b>bold</b>');
    expect(root.querySelectorAll('img, b')).toHaveLength(0);
  });

  it('draws each of the nine templates', () => {
    const text = ['cover', 'interstitial', 'half_interstitial', 'header', 'footer'];
    for (const template of text) {
      const { root, renderer } = open({ template, content: { image: IMAGE } });
      expect(root.querySelector(`.layer.${template}`)).not.toBeNull();
      expect(root.querySelector('.title')?.textContent).toBe('Hello');
      expect(root.querySelector('img.media')).not.toBeNull();
      renderer.dismiss();
    }
    for (const template of ['cover_image', 'interstitial_image', 'half_interstitial_image']) {
      const { root, renderer } = open(
        { template, content: { title: null, message: null, image: IMAGE } },
        { title: null, message: null },
      );
      expect(root.querySelector('img.media')).not.toBeNull();
      expect(root.querySelector('.title, .message, .button')).toBeNull();
      renderer.dismiss();
    }
    const { root } = open({ template: 'alert' });
    expect(root.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(root.querySelector('img')).toBeNull();
  });

  it('marks blocking templates as modal and leaves banners open to the page', () => {
    const blocking = open({ template: 'interstitial' });
    expect(blocking.root.querySelector('.card')?.getAttribute('aria-modal')).toBe('true');
    expect(blocking.root.querySelectorAll('.sentinel')).toHaveLength(2);
    blocking.renderer.dismiss();

    const banner = open({ template: 'footer' });
    expect(banner.root.querySelector('.card')?.hasAttribute('aria-modal')).toBe(false);
    expect(banner.root.querySelectorAll('.sentinel')).toHaveLength(0);
    expect(banner.root.querySelector('.layer')?.classList.contains('dim')).toBe(false);
  });

  it('reports a click with the button and opens its filled link', async () => {
    const buttons = [
      { id: 'later', text: 'Later', action: { type: 'close' } },
      { id: 'shop', text: 'Shop', action: { type: 'open_url', url: 'https://acme.example/{{ event.p }}' } },
    ];
    const { root, outcome, visited } = open(
      { content: { buttons, tap_action: { type: 'open_url', url: 'https://acme.example/tap' } } },
      { buttons: ['Later', 'Shop now'], urls: ['https://acme.example/shoes', 'https://acme.example/tap'] },
    );
    const drawn = root.querySelectorAll<HTMLButtonElement>('.button');
    expect(Array.from(drawn).map((b) => b.textContent)).toEqual(['Later', 'Shop now']);

    drawn[1]?.click();
    await settle();
    expect(outcome.value).toMatchObject({ kind: 'clicked', buttonId: 'shop', action: { type: 'open_url' } });
    expect(visited).toEqual(['https://acme.example/shoes']);
    expect(document.getElementById('grovs-in-app')).toBeNull();
  });

  it('keeps the text clear of the close button when no picture sits under it', () => {
    const clear = (changes: Json) => {
      document.body.replaceChildren();
      return open(changes).root.querySelector('.card')?.classList.contains('clear');
    };
    expect(clear({})).toBe(true);
    expect(clear({ content: { close_button: false } })).toBe(false);
    expect(clear({ template: 'alert' })).toBe(true);
  });

  it('turns text and the close button light on a dark background, and keeps a colour that was given', () => {
    const card = (colors: Json) => {
      document.body.replaceChildren();
      return open({ content: { colors } }).root.querySelector<HTMLElement>('.card');
    };
    expect(card({ background: '#111827' })?.classList.contains('dark')).toBe(true);
    expect(card({ background: '#FFE08A' })?.classList.contains('dark')).toBe(false);
    expect(card({})?.classList.contains('dark')).toBe(false);
    const tinted = card({ background: '#111827', title: '#FFD166' });
    expect(tinted?.querySelector<HTMLElement>('.title')?.style.color).toBe('rgb(255, 209, 102)');
  });

  it('a message that cannot be dismissed closes only through its button', async () => {
    const buttons = [{ id: 'update', text: 'Update', action: { type: 'close' } }];
    const { root, outcome } = open({ content: { dismissible: false, close_button: true, buttons } }, { buttons: ['Update'] });
    expect(root.querySelector('.close')).toBeNull();
    root.querySelector<HTMLElement>('.layer')?.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(outcome.value).toBeNull();
    root.querySelector<HTMLButtonElement>('.button')?.click();
    await settle();
    expect(outcome.value).toMatchObject({ kind: 'clicked', buttonId: 'update' });
  });

  it('a message that can be dismissed still closes on Escape and on a click outside it', async () => {
    const first = open({});
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(first.outcome.value).toMatchObject({ kind: 'dismissed' });
    document.body.replaceChildren();
    const second = open({ content: { dismissible: true } });
    second.root.querySelector<HTMLElement>('.layer')?.click();
    await settle();
    expect(second.outcome.value).toEqual({ kind: 'dismissed', reason: 'backdrop' });
  });

  it('a close button click closes without opening anything', async () => {
    const buttons = [{ id: 'later', text: 'Later', action: { type: 'close' } }];
    const { root, outcome, visited } = open({ content: { buttons } }, { buttons: ['Later'] });
    root.querySelector<HTMLButtonElement>('.button')?.click();
    await settle();
    expect(outcome.value).toMatchObject({ kind: 'clicked', buttonId: 'later', action: { type: 'close' } });
    expect(visited).toEqual([]);
  });

  it('a tap on an image-only message reports no button and opens the tap link', async () => {
    const { root, outcome, visited } = open(
      {
        template: 'cover_image',
        content: { title: null, message: null, image: IMAGE, tap_action: { type: 'open_url', url: 'https://acme.example/tap' } },
      },
      { title: null, message: null, urls: ['https://acme.example/tap'] },
    );
    const image = root.querySelector<HTMLElement>('img.media');
    expect(image?.getAttribute('role')).toBe('button');
    image?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(outcome.value).toMatchObject({ kind: 'clicked', buttonId: null });
    expect(visited).toEqual(['https://acme.example/tap']);
  });

  it('reports why it was dismissed', async () => {
    const byButton = open({});
    byButton.root.querySelector<HTMLButtonElement>('.close')?.click();
    await settle();
    expect(byButton.outcome.value).toEqual({ kind: 'dismissed', reason: 'close_button' });

    const byBackdrop = open({});
    byBackdrop.root.querySelector<HTMLElement>('.layer')?.click();
    await settle();
    expect(byBackdrop.outcome.value).toEqual({ kind: 'dismissed', reason: 'backdrop' });

    const byKey = open({});
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(byKey.outcome.value).toEqual({ kind: 'dismissed', reason: 'close_button' });

    const byApp = open({});
    byApp.renderer.dismiss();
    await settle();
    expect(byApp.outcome.value).toEqual({ kind: 'dismissed', reason: 'app' });
  });

  it('a click inside the card is not a backdrop click, and Escape leaves a banner alone', async () => {
    const card = open({});
    card.root.querySelector<HTMLElement>('.card')?.click();
    await settle();
    expect(card.outcome.value).toBeNull();
    card.renderer.dismiss();

    const banner = open({ template: 'header' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(banner.outcome.value).toBeNull();
  });

  it('omits the close button when the campaign says so', () => {
    expect(open({ content: { close_button: false } }).root.querySelector('.close')).toBeNull();
  });

  it('applies colours only when they are hex colours', () => {
    const { root, renderer: first } = open({ content: { colors: { background: '#112233', title: '#AABBCC' } } });
    expect(root.querySelector<HTMLElement>('.card')?.style.background).toBe('rgb(17, 34, 51)');
    expect(root.querySelector<HTMLElement>('.title')?.style.color).toBe('rgb(170, 187, 204)');
    first.dismiss();

    const campaign = readCampaign(merge(BASE, {}));
    if (!campaign) throw new Error('campaign did not read');
    campaign.raw = merge(campaign.raw, { content: { colors: { background: 'url(https://evil.example)' } } });
    const renderer = new InAppRenderer(document, new Logger(), () => undefined);
    void renderer.present({ campaign, rendered: { title: 'Hello', message: null, buttons: [], urls: [] } });
    const card = document.getElementById('grovs-in-app')?.shadowRoot?.querySelector<HTMLElement>('.card');
    expect(card?.style.background).toBe('');
  });

  it('moves focus into a blocking message and gives it back', async () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    const { renderer, root } = open({});
    expect(root.activeElement?.classList.contains('card')).toBe(true);
    renderer.dismiss();
    await settle();
    expect(document.activeElement).toBe(before);
  });

  it('shows one message at a time: a second replaces the first', async () => {
    const first = open({});
    const campaign = readCampaign(merge(BASE, { id: 'c2' }));
    if (!campaign) throw new Error('campaign did not read');
    void first.renderer.present({ campaign, rendered: { title: 'Second', message: null, buttons: [], urls: [] } });
    await settle();
    expect(first.outcome.value).toEqual({ kind: 'dismissed', reason: 'app' });
    expect(document.querySelectorAll('#grovs-in-app')).toHaveLength(1);
  });

  it('swaps the image when the window turns', () => {
    const { root } = open({ content: { image: IMAGE } });
    const image = root.querySelector<HTMLImageElement>('img.media');
    const wide = window.innerWidth > window.innerHeight;
    expect(image?.getAttribute('src')).toBe(wide ? IMAGE.landscape : IMAGE.portrait);
    Object.defineProperty(window, 'innerWidth', { value: wide ? 300 : 2000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(image?.getAttribute('src')).toBe(wide ? IMAGE.portrait : IMAGE.landscape);
  });

  it('contains a link that cannot be opened', async () => {
    const campaign = readCampaign(
      merge(BASE, { content: { tap_action: { type: 'open_url', url: 'https://acme.example/' } } }),
    );
    if (!campaign) throw new Error('campaign did not read');
    const renderer = new InAppRenderer(document, new Logger(), () => {
      throw new Error('blocked');
    });
    void renderer.present({ campaign, rendered: { title: 'Hello', message: null, buttons: [], urls: ['https://acme.example/'] } });
    const card = document.getElementById('grovs-in-app')?.shadowRoot?.querySelector<HTMLElement>('.card');
    expect(() => card?.click()).not.toThrow();
  });

  it('knows when the page took the message away, and removes its listeners when closed', async () => {
    const { renderer, outcome } = open({});
    expect(renderer.lost()).toBe(false);
    document.body.replaceChildren();
    expect(renderer.lost()).toBe(true);
    renderer.dismiss();
    await settle();
    expect(outcome.value).toEqual({ kind: 'dismissed', reason: 'app' });
    expect(renderer.lost()).toBe(false);
  });

  it('leaves no key listener behind when the host closes the message as it is shown', () => {
    const campaign = readCampaign(merge(BASE, {}));
    if (!campaign) throw new Error('campaign did not read');
    const added: string[] = [];
    const removed: string[] = [];
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      (add as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      (remove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      const renderer = new InAppRenderer(document, new Logger(), () => undefined);
      const rendered = { title: 'Hello', message: null, buttons: [], urls: [] };
      void renderer.present({ campaign, rendered }, () => renderer.dismiss());
      expect(removed.filter((type) => type === 'keydown')).toHaveLength(added.filter((type) => type === 'keydown').length);
    } finally {
      document.addEventListener = add;
      document.removeEventListener = remove;
    }
  });
});
