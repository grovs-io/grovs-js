import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../../src/logging/logger';
import { readCampaign } from '../../src/inapp/definition';
import type { Answered, Commented, Outcome } from '../../src/inapp/controller';
import { InAppRenderer } from '../../src/inapp/renderer';
import type { Rendered } from '../../src/inapp/types';
import { merge, readJson } from './shared';

type Json = Record<string, unknown>;
/** What the host does at the answer and at Send, besides having them recorded. */
type Hooks = { answered?: Answered; commented?: Commented };

const BASE = readJson('cases.json').base_campaign as Json;
const IMAGE = { portrait: 'https://cdn.example/p.png', landscape: 'https://cdn.example/l.png' };

function open(changes: Json, rendered: Partial<Rendered> = {}, hooks: Hooks = {}) {
  const campaign = readCampaign(merge(BASE, changes));
  if (!campaign) throw new Error('campaign did not read');
  const visited: string[] = [];
  const logger = new Logger();
  logger.setLevel('warn');
  const renderer = new InAppRenderer(document, logger, (url) => visited.push(url));
  const outcome: { value: Outcome | null } = { value: null };
  const answers: (number | string)[] = [];
  const comments: string[] = [];
  void renderer
    .present(
      { campaign, rendered: { title: 'Hello', message: 'Welcome', buttons: [], urls: [], ...rendered } },
      undefined,
      (value) => {
        answers.push(value);
        hooks.answered?.(value);
      },
      (text) => {
        comments.push(text);
        hooks.commented?.(text);
      },
    )
    .then((value) => {
      outcome.value = value;
    });
  const root = document.getElementById('grovs-in-app')?.shadowRoot;
  if (!root) throw new Error('nothing was drawn');
  return { renderer, root, outcome, visited, answers, comments };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('InAppRenderer', () => {
  it('closes a message for one orientation when the device turns the other way, and stops listening', async () => {
    const query = { matches: true, listeners: new Set<() => void>() };
    const media = {
      get matches() {
        return query.matches;
      },
      addEventListener: (_: string, fn: () => void) => query.listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => query.listeners.delete(fn),
    };
    vi.stubGlobal('matchMedia', () => media);
    try {
      const { outcome } = open({ content: { orientation: 'portrait' } });
      query.listeners.forEach((fn) => fn());
      await settle();
      expect(outcome.value).toBeNull();
      query.matches = false;
      query.listeners.forEach((fn) => fn());
      await settle();
      expect(outcome.value).toEqual({ kind: 'dismissed', reason: 'orientation' });
      expect(query.listeners.size).toBe(0);
      document.body.replaceChildren();
      open({ content: { orientation: 'any' } });
      expect(query.listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
    // The filled link, not the template: the controller judges whether it leaves the page.
    expect(outcome.value).toMatchObject({ kind: 'clicked', buttonId: 'shop', action: { type: 'open_url', url: 'https://acme.example/shoes' } });
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

describe('InAppRenderer questions', () => {
  const COMMENT = { split: 3, low: 'What went wrong?', high: 'What did you like?' };
  const OPTIONS = [
    { id: 'search', text: 'Search' },
    { id: 'friend', text: '<b>A friend</b>' },
    { id: 'ad', text: 'An ad' },
  ];

  function ask(question: Json, content: Json = {}, template = 'interstitial', hooks: Hooks = {}) {
    const whole = { id: 'q1', type: 'stars', options: [], comment: null, thanks: null, review_from: null, ...question };
    const drawn = open({ template, content: { ...content, question: whole } }, {}, hooks);
    const named = (name: string): HTMLButtonElement | undefined =>
      Array.from(drawn.root.querySelectorAll('button')).find(
        (button) => (button.getAttribute('aria-label') ?? button.textContent) === name,
      );
    const tap = (name: string): void => named(name)?.click();
    const input = (): HTMLTextAreaElement | null => drawn.root.querySelector('textarea');
    const closed = (): boolean => document.getElementById('grovs-in-app') === null;
    return { ...drawn, named, tap, input, closed };
  }

  it('draws five stars or one button per option, each with a name, under the text', () => {
    for (const template of ['cover', 'interstitial', 'half_interstitial', 'header', 'footer']) {
      const stars = ask({}, {}, template);
      const buttons = Array.from(stars.root.querySelectorAll('.question button'));
      expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['1 of 5', '2 of 5', '3 of 5', '4 of 5', '5 of 5']);
      expect(buttons.every((button) => button.tagName === 'BUTTON')).toBe(true);
      const group = stars.root.querySelector('.body')?.lastElementChild;
      expect(group?.className).toBe('question stars');
      expect(group?.getAttribute('role')).toBe('group');
      expect(group?.getAttribute('aria-label')).toBe('Rating');
      stars.renderer.dismiss();
    }

    const choice = ask({ type: 'choice', options: OPTIONS });
    const options = Array.from(choice.root.querySelectorAll('.question button'));
    expect(options.map((button) => button.textContent)).toEqual(['Search', '<b>A friend</b>', 'An ad']);
    expect(choice.root.querySelector('.question')?.hasAttribute('role')).toBe(false);
  });

  it('draws a question that has no title and no message', () => {
    const { root } = open(
      { content: { title: null, message: null, question: { id: 'q1', type: 'stars', options: [], comment: null, thanks: null } } },
      { title: null, message: null },
    );
    expect(root.querySelectorAll('.body > .question button')).toHaveLength(5);
  });

  it('answers at one tap, once, and closes at once when nothing follows', async () => {
    const stars = ask({});
    stars.tap('4 of 5');
    expect(stars.answers).toEqual([4]);
    expect(stars.closed()).toBe(true);
    stars.tap('2 of 5');
    await settle();
    expect(stars.answers).toEqual([4]);
    expect(stars.outcome.value).toEqual({ kind: 'answered', value: 4, comment: null });

    const choice = ask({ type: 'choice', options: OPTIONS });
    choice.tap('An ad');
    await settle();
    expect(choice.outcome.value).toEqual({ kind: 'answered', value: 'ad', comment: null });
  });

  it('does not answer twice when tapped twice', () => {
    const { named, answers, root } = ask({ comment: COMMENT });
    const star = named('2 of 5');
    star?.click();
    star?.click();
    expect(answers).toEqual([2]);
    expect(root.querySelectorAll('textarea')).toHaveLength(1);
  });

  it('asks the comment that belongs to the answer', () => {
    const prompt = (question: Json, answer: string): string | null => {
      document.body.replaceChildren();
      const asked = ask(question);
      asked.tap(answer);
      return asked.input()?.getAttribute('aria-label') ?? null;
    };
    expect(prompt({ comment: COMMENT }, '2 of 5')).toBe('What went wrong?');
    expect(prompt({ comment: COMMENT }, '3 of 5')).toBe('What went wrong?');
    expect(prompt({ comment: COMMENT }, '4 of 5')).toBe('What did you like?');
    expect(prompt({ comment: { ...COMMENT, split: null } }, '5 of 5')).toBe('What went wrong?');
    expect(prompt({ type: 'choice', options: OPTIONS, comment: { ...COMMENT, split: null } }, 'Search')).toBe('What went wrong?');
    expect(prompt({ comment: { ...COMMENT, high: null } }, '5 of 5')).toBeNull();
    expect(prompt({ comment: { ...COMMENT, low: null } }, '1 of 5')).toBeNull();
    expect(prompt({ comment: { split: null, low: null, high: 'Never asked' } }, '5 of 5')).toBeNull();
    expect(prompt({ comment: null }, '5 of 5')).toBeNull();
  });

  it('replaces the question with the prompt, a text box of 500 characters, Send and Skip', () => {
    const { root, tap, input, named, outcome } = ask({ comment: COMMENT });
    tap('1 of 5');
    expect(root.querySelector('.title')?.textContent).toBe('Hello');
    expect(root.querySelector('.question .message')?.textContent).toBe('What went wrong?');
    expect(root.querySelector('[aria-label="1 of 5"]')).toBeNull();
    expect(input()?.maxLength).toBe(500);
    expect(root.activeElement).toBe(input());
    expect(named('Send')).toBeDefined();
    expect(named('Skip')).toBeDefined();
    expect(outcome.value).toBeNull();
  });

  it('Send trims the comment and keeps 500 UTF-16 units; only spaces is a Skip', async () => {
    const sent = async (text: string): Promise<{ outcome: Outcome | null; told: string[] }> => {
      document.body.replaceChildren();
      const asked = ask({ comment: COMMENT });
      asked.tap('5 of 5');
      const input = asked.input();
      if (input) input.value = text;
      asked.tap('Send');
      await settle();
      return { outcome: asked.outcome.value, told: asked.comments };
    };
    const answered = (comment: string | null): Outcome => ({ kind: 'answered', value: 5, comment });
    expect(await sent('  Fast delivery \n')).toEqual({ outcome: answered('Fast delivery'), told: ['Fast delivery'] });
    expect(await sent(` ${'x'.repeat(600)}`)).toEqual({ outcome: answered('x'.repeat(500)), told: ['x'.repeat(500)] });
    // A character outside the basic plane is two units, so 300 of them are cut to 250.
    expect(await sent('\u{1F600}'.repeat(300))).toEqual({ outcome: answered('\u{1F600}'.repeat(250)), told: ['\u{1F600}'.repeat(250)] });
    expect(await sent(' \n\t ')).toEqual({ outcome: answered(null), told: [] });
    expect(await sent('')).toEqual({ outcome: answered(null), told: [] });
  });

  it('tells the host the comment at Send, before the thanks, and once', async () => {
    vi.useFakeTimers();
    const { tap, input, outcome, comments } = ask({ comment: COMMENT, thanks: 'Thank you' });
    tap('2 of 5');
    const box = input();
    if (box) box.value = ' Late ';
    tap('Send');
    expect(comments).toEqual(['Late']);
    expect(outcome.value).toBeNull();
    vi.advanceTimersByTime(2000);
    await settle();
    expect(comments).toEqual(['Late']);
    expect(outcome.value).toEqual({ kind: 'answered', value: 2, comment: 'Late' });
  });

  it('Skip closes with no comment, whatever was typed', async () => {
    const { tap, input, outcome, closed, comments } = ask({ comment: COMMENT });
    tap('5 of 5');
    const box = input();
    if (box) box.value = 'Typed and left';
    tap('Skip');
    await settle();
    expect(outcome.value).toEqual({ kind: 'answered', value: 5, comment: null });
    expect(comments).toEqual([]);
    expect(closed()).toBe(true);
  });

  it('goes on when the host throws at the answer or at Send, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bug = (): never => {
      throw new Error('host bug');
    };
    const asked = ask({ comment: COMMENT }, {}, 'interstitial', { answered: bug, commented: bug });
    asked.tap('1 of 5');
    expect(asked.input()).not.toBeNull();
    const box = asked.input();
    if (box) box.value = 'Slow';
    asked.tap('Send');
    await settle();
    expect(asked.outcome.value).toEqual({ kind: 'answered', value: 1, comment: 'Slow' });
    expect(asked.closed()).toBe(true);
    expect(asked.answers).toEqual([1]);
    expect(asked.comments).toEqual(['Slow']);
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('host bug'),
      expect.stringContaining('host bug'),
    ]);
    warn.mockRestore();
  });

  it('shows the thanks for two seconds, then closes', async () => {
    vi.useFakeTimers();
    const { root, tap, outcome, closed } = ask({ thanks: 'Thank you' });
    tap('5 of 5');
    const line = root.querySelector('.body > .message');
    expect(line?.textContent).toBe('Thank you');
    expect(root.querySelector('.question, .title')).toBeNull();
    // Read out by focus, as a live region that appears with its text already in it may not be.
    expect(line?.getAttribute('role')).toBe('status');
    expect(line?.getAttribute('aria-live')).toBe('polite');
    expect(root.activeElement).toBe(line);

    vi.advanceTimersByTime(1999);
    await settle();
    expect(outcome.value).toBeNull();
    vi.advanceTimersByTime(1);
    await settle();
    expect(outcome.value).toEqual({ kind: 'answered', value: 5, comment: null });
    expect(closed()).toBe(true);
  });

  it('shows the thanks after the comment, sent or skipped', async () => {
    vi.useFakeTimers();
    for (const button of ['Send', 'Skip']) {
      const { root, tap, input, outcome } = ask({ comment: COMMENT, thanks: 'Thank you' });
      tap('2 of 5');
      const box = input();
      if (box) box.value = 'Late';
      tap(button);
      expect(root.querySelector('.body')?.textContent).toBe('Thank you');
      vi.advanceTimersByTime(2000);
      await settle();
      expect(outcome.value).toEqual({ kind: 'answered', value: 2, comment: button === 'Send' ? 'Late' : null });
    }
  });

  it('closing before the answer is a dismissal with its usual reason', async () => {
    const ways: [(asked: ReturnType<typeof ask>) => void, string][] = [
      [(asked) => asked.tap('Close'), 'close_button'],
      [(asked) => asked.root.querySelector<HTMLElement>('.layer')?.click(), 'backdrop'],
      [() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), 'close_button'],
      [(asked) => asked.renderer.dismiss(), 'app'],
    ];
    for (const [close, reason] of ways) {
      const asked = ask({ comment: COMMENT, thanks: 'Thank you' });
      close(asked);
      await settle();
      expect(asked.outcome.value).toEqual({ kind: 'dismissed', reason });
      expect(asked.answers).toEqual([]);
    }
  });

  it('closing while the comment is asked, or the thanks shows, is an answer', async () => {
    vi.useFakeTimers();
    const ways: ((asked: ReturnType<typeof ask>) => void)[] = [
      (asked) => asked.tap('Close'),
      (asked) => asked.root.querySelector<HTMLElement>('.layer')?.click(),
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      (asked) => asked.renderer.dismiss(),
    ];
    for (const close of ways) {
      const commenting = ask({ comment: COMMENT, thanks: 'Thank you' });
      commenting.tap('2 of 5');
      const box = commenting.input();
      if (box) box.value = 'Never sent';
      close(commenting);
      await settle();
      expect(commenting.outcome.value).toEqual({ kind: 'answered', value: 2, comment: null });

      const thanked = ask({ comment: COMMENT, thanks: 'Thank you' });
      thanked.tap('2 of 5');
      const input = thanked.input();
      if (input) input.value = 'Sent';
      thanked.tap('Send');
      close(thanked);
      await settle();
      expect(thanked.outcome.value).toEqual({ kind: 'answered', value: 2, comment: 'Sent' });
      expect(thanked.closed()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('a question that cannot be dismissed closes only through its answer', async () => {
    vi.useFakeTimers();
    const leave = (asked: ReturnType<typeof ask>): void => {
      asked.root.querySelector<HTMLElement>('.layer')?.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    };
    const asked = ask({ comment: COMMENT, thanks: 'Thank you' }, { dismissible: false, close_button: true });
    expect(asked.named('Close')).toBeUndefined();
    leave(asked);
    await settle();
    expect(asked.outcome.value).toBeNull();
    expect(asked.closed()).toBe(false);

    asked.tap('1 of 5');
    leave(asked);
    await settle();
    expect(asked.outcome.value).toBeNull();
    asked.tap('Skip');
    leave(asked);
    await settle();
    expect(asked.outcome.value).toBeNull();
    vi.advanceTimersByTime(2000);
    await settle();
    expect(asked.outcome.value).toEqual({ kind: 'answered', value: 1, comment: null });
  });

  it('draws options, prompts and thanks as text, never as markup', () => {
    const markup = '<img src=x onerror=alert(1)>';
    const options = [
      { id: 'a', text: markup },
      { id: 'b', text: '<b>bold</b>' },
    ];
    const { root, tap, named } = ask({ type: 'choice', options, comment: { split: null, low: markup, high: null }, thanks: markup });
    expect(named(markup)).toBeDefined();
    expect(root.querySelectorAll('img, b')).toHaveLength(0);
    tap(markup);
    expect(root.querySelector('.question .message')?.textContent).toBe(markup);
    expect(root.querySelectorAll('img, b')).toHaveLength(0);
    tap('Skip');
    expect(root.querySelector('.body')?.textContent).toBe(markup);
    expect(root.querySelectorAll('img, b')).toHaveLength(0);
  });

  it('keeps the text box inside the focus trap', () => {
    const { root, tap, input, named } = ask({ comment: COMMENT });
    tap('1 of 5');
    const [start, end] = Array.from(root.querySelectorAll<HTMLElement>('.sentinel'));
    end?.dispatchEvent(new FocusEvent('focus'));
    expect(root.activeElement).toBe(input());
    start?.dispatchEvent(new FocusEvent('focus'));
    expect(root.activeElement).toBe(named('Close'));
  });

  it('stops when reporting the comment closed the message', async () => {
    vi.useFakeTimers();
    const hooks: Hooks = {};
    const asked = ask({ comment: COMMENT, thanks: 'Thank you' }, {}, 'interstitial', hooks);
    hooks.commented = () => asked.renderer.dismiss();
    asked.tap('2 of 5');
    const box = asked.input();
    if (box) box.value = 'Bye';
    asked.tap('Send');
    await settle();
    expect(asked.outcome.value).toEqual({ kind: 'answered', value: 2, comment: 'Bye' });
    expect(asked.closed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops when reporting the answer closed the message', async () => {
    const campaign = readCampaign(
      merge(BASE, { content: { question: { id: 'q1', type: 'stars', options: [], comment: COMMENT, thanks: 'Thank you' } } }),
    );
    if (!campaign) throw new Error('campaign did not read');
    const renderer = new InAppRenderer(document, new Logger(), () => undefined);
    const rendered = { title: 'Hello', message: null, buttons: [], urls: [] };
    const outcome = renderer.present({ campaign, rendered }, undefined, () => renderer.dismiss());
    const root = document.getElementById('grovs-in-app')?.shadowRoot;
    root?.querySelector<HTMLButtonElement>('[aria-label="5 of 5"]')?.click();
    expect(await outcome).toEqual({ kind: 'answered', value: 5, comment: null });
    expect(root?.querySelector('textarea')).toBeNull();
  });
});
