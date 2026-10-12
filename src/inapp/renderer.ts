import type { Logger } from '../logging/logger';
import type { Answered, Commented, Outcome, Page, Presentation, Presenter } from './controller';
import { HtmlFrame } from './htmlFrame';
import type { Action, Campaign, Question } from './types';

/**
 * Draws one in-app message in a shadow root and reports what the visitor did.
 *
 * It knows nothing about triggers, caps or schedules: it is handed a campaign
 * the engine chose and the text the engine filled. Text is set with
 * textContent, never as markup, and styles go through CSSOM, so a strict
 * content security policy on the host page does not blank the message.
 */

const HOST_ID = 'grovs-in-app';
const COLOR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const BANNERS: readonly string[] = ['header', 'footer'];
const IMAGE_ONLY: readonly string[] = ['cover_image', 'interstitial_image', 'half_interstitial_image'];
const COMMENT_MAX = 500;
const THANKS_MS = 2_000;
/** One deadline from the start of a show to the page being on screen. */
const PAGE_DEADLINE = 5_000;

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.layer.dim { background: rgba(0, 0, 0, 0.55); }
.layer.banner { inset: auto 0; pointer-events: none; align-items: stretch; }
.layer.header { top: 0; }
.layer.footer { bottom: 0; }
.card { position: relative; display: flex; flex-direction: column; overflow: hidden; pointer-events: auto;
  background: #ffffff; color: #111111; border-radius: 14px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  max-height: 92vh; max-width: 92vw; }
.cover .card, .cover_image .card { width: 100vw; height: 100vh; max-width: none; max-height: none; border-radius: 0; }
.card:focus { outline: none; }
.cover .body, .cover .buttons { width: 100%; max-width: 640px; margin: 0 auto; box-sizing: border-box; }
/* With no picture to take up the room, the text sits in the middle and the buttons at the foot. */
.cover .plain .body { margin: auto; }
.interstitial .card, .interstitial_image .card { width: 640px; }
.half_interstitial .card, .half_interstitial_image .card { width: 420px; max-width: 78vw; }
.alert .card { width: 340px; }
.banner .card { width: 100%; max-width: none; flex-direction: row; align-items: center; gap: 12px; padding: 12px 44px 12px 12px;
  border-radius: 0; box-shadow: 0 2px 16px rgba(0, 0, 0, 0.2); }
.media { display: block; width: 100%; object-fit: cover; min-height: 0; flex: 1 1 auto; }
.interstitial .media { aspect-ratio: 16 / 9; flex: none; }
.half_interstitial .media { aspect-ratio: 13 / 10; flex: none; }
.interstitial_image .media { aspect-ratio: 16 / 9; }
.half_interstitial_image .media { aspect-ratio: 13 / 10; }
.banner .media { width: 48px; height: 48px; flex: none; border-radius: 8px; }
.tap { cursor: pointer; }
/* The text gives way and scrolls, so the buttons under it are never pushed off a small screen. */
.body { display: flex; flex-direction: column; gap: 8px; padding: 20px; flex: 0 1 auto; min-height: 0; overflow-y: auto; }
.clear .body > :first-child { padding-right: 28px; }
.banner .body { padding: 0; flex: 1 1 auto; gap: 2px; min-width: 0; }
.title { font-size: 20px; font-weight: 700; line-height: 1.25; margin: 0; overflow-wrap: anywhere; }
.message { font-size: 15px; line-height: 1.45; margin: 0; overflow-wrap: anywhere; white-space: pre-line; }
.banner .title { font-size: 15px; }
.banner .message { font-size: 13px; }
.buttons { display: flex; gap: 10px; padding: 0 20px 20px; flex: none; }
.banner .buttons { padding: 0; flex: none; }
.button { flex: 1 1 0; border: 0; border-radius: 10px; padding: 12px 16px; font: inherit; font-size: 15px; font-weight: 600;
  cursor: pointer; background: #2a86ff; color: #ffffff; }
.button + .button { background: #e9eef5; color: #111111; }
.banner .button { flex: none; padding: 8px 12px; font-size: 13px; }
.close { position: absolute; top: 12px; right: 12px; width: 28px; height: 28px; border: 0; border-radius: 14px; cursor: pointer;
  font-size: 13px; line-height: 28px; text-align: center; background: rgba(0, 0, 0, 0.45); color: #ffffff; padding: 0; }
/* 20px of padding and half of the first line, less half the button: level with that line. */
.clear .close { top: 18px; }
.clear .close, .banner .close { background: rgba(0, 0, 0, 0.06); color: #555555; }
.question { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.question.choice { flex-direction: column; }
.question .buttons { padding: 0; width: 100%; }
.star, .pick { border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.star { padding: 0 2px; font-size: 32px; line-height: 1; }
.star::before { content: "\\2606"; }
.stars:hover .star::before, .stars:focus-within .star::before { content: "\\2605"; }
.stars .star:hover ~ .star::before, .stars:not(:hover) .star:focus ~ .star::before { content: "\\2606"; }
.pick { border-radius: 10px; padding: 12px 16px; font-size: 15px; font-weight: 600; background: #e9eef5; color: #111111; overflow-wrap: anywhere; }
.dark .pick { background: rgba(255, 255, 255, 0.16); color: #ffffff; }
.input { width: 100%; min-height: 72px; border: 1px solid #8a9099; border-radius: 10px; padding: 10px; font: inherit;
  font-size: 15px; resize: vertical; background: #ffffff; color: #111111; }
.banner .star { font-size: 26px; }
.banner .input { min-height: 44px; }
.dark .title, .dark .message, .dark .question { color: #ffffff; }
.dark.clear .close, .banner .dark .close { background: rgba(255, 255, 255, 0.16); color: #ffffff; }
.banner .close { top: 50%; margin-top: -14px; }
/* A banner with a question is several rows tall: its close button sits by the title and the rows run full width. */
.banner .asks { flex-wrap: wrap; padding-right: 12px; }
.banner .asks .body > :first-child { padding-right: 32px; }
.banner .asks .close { top: 10px; margin-top: 0; }
.banner .asks .question, .banner .asks .buttons { width: 100%; flex: 1 1 100%; }
/* On a wide screen a banner's rows stop at a readable width, as a cover's do. */
.banner .asks .question, .banner .asks .buttons, .banner .asks .prompt, .banner .asks .input { max-width: 640px; }
.banner .asks .buttons .button { flex: 1 1 0; }
.button:focus-visible, .close:focus-visible, .tap:focus-visible, .star:focus-visible, .pick:focus-visible, .input:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
.layer.banner_top { top: 0; }
.layer.banner_bottom { bottom: 0; }
/* Laid out at its final width but invisible, never display: none, so the page can be measured. */
.layer.html.pending { visibility: hidden; }
.layer.html .card { display: block; padding: 0; width: min(420px, calc(100vw - 32px)); max-width: none; max-height: none; }
/* Starts at its largest, so a page that fills its frame shows at full size instead of collapsing; never below the close target. */
.layer.html .frame { display: block; width: 100%; height: 90vh; border: 0; max-height: 90vh; min-height: 44px; }
.layer.html.banner .card { width: 100%; border-radius: 0; }
.layer.html.banner .frame { height: 30vh; max-height: 30vh; }
@media (max-height: 500px) { .layer.html.banner .frame { height: 45vh; max-height: 45vh; } }
.layer.html.banner_top { padding-top: env(safe-area-inset-top); }
.layer.html.full { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
.layer.html.full .card { width: 100%; height: 100%; border-radius: 0; box-shadow: none; }
.layer.html.full .frame { height: 100%; max-height: none; }
/* A 44px target round a smaller visible button. */
.layer.html .close { top: 0; right: 0; margin: 0; width: 44px; height: 44px; padding: 8px; border-radius: 50%;
  background: rgba(0, 0, 0, 0.45); background-clip: content-box; color: #ffffff; z-index: 1; }
.sentinel { position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
@media (max-width: 600px) {
  .banner .card { flex-wrap: wrap; }
  .banner .body { flex: 1 1 0; }
  .banner .buttons { flex: 1 1 100%; }
  .banner .button { flex: 1 1 0; }
}
@media (prefers-reduced-motion: no-preference) {
  .card { animation: grovs-in 160ms ease-out; }
  @keyframes grovs-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
}
`;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether text on this colour should be light; the usual weighting of red, green and blue. */
export function isDark(hex: string): boolean {
  const part = (at: number): number => parseInt(hex.slice(at, at + 2), 16);
  return (part(1) * 299 + part(3) * 587 + part(5) * 114) / 1000 < 128;
}

function color(value: unknown): string | null {
  return typeof value === 'string' && COLOR.test(value) ? value : null;
}

interface Open {
  host: HTMLElement;
  root: ShadowRoot;
  finish: (outcome: Outcome) => void;
  restore: HTMLElement | null;
  cleanup: (() => void)[];
  /** Set at the tap that answers the question. */
  answer: { value: number | string; comment: string | null } | null;
}

export class InAppRenderer implements Presenter {
  private open: Open | null = null;
  private sheet: CSSStyleSheet | null = null;

  constructor(
    private readonly doc: Document,
    private readonly logger: Logger,
    private readonly navigate: (url: string) => void,
  ) {}

  present(
    presentation: Presentation,
    drawn: () => void = () => undefined,
    answered: Answered = () => undefined,
    commented: Commented = () => undefined,
  ): Promise<Outcome> {
    this.dismiss();
    if (!this.doc.body) return Promise.reject(new Error('the page has no body'));
    return new Promise((resolve) => {
      const host = this.doc.createElement('div');
      host.id = HOST_ID;
      const root = host.attachShadow({ mode: 'open' });
      const open: Open = { host, root, restore: this.active(), cleanup: [], answer: null, finish: () => undefined };
      let done = false;
      open.finish = (outcome) => {
        if (done) return;
        done = true;
        this.close(open);
        // Once the question is answered, every way of closing is an answer.
        resolve(open.answer ? { kind: 'answered', ...open.answer } : outcome);
      };
      this.open = open;
      this.style(root);
      // Turned away from its orientation, the message closes: not the person's dismissal.
      const only = presentation.campaign.content.orientation;
      const query = only && this.doc.defaultView?.matchMedia?.('(orientation: portrait)');
      if (query) {
        const turned = (): void => {
          if (query.matches !== (only === 'portrait')) open.finish({ kind: 'dismissed', reason: 'orientation' });
        };
        query.addEventListener('change', turned);
        open.cleanup.push(() => query.removeEventListener('change', turned));
      }
      if (presentation.page) {
        this.drawPage(open, presentation.campaign, presentation.page, drawn);
        this.doc.body.appendChild(host);
        return;
      }
      this.draw(open, presentation, answered, commented);
      this.doc.body.appendChild(host);
      // Focus first: the host may close the message from onShown, and close() must find every listener to remove.
      this.focus(open, BANNERS.includes(presentation.campaign.template), presentation.campaign.content.dismissible);
      drawn();
    });
  }

  lost(): boolean {
    return this.open !== null && !this.open.host.isConnected;
  }

  dismiss(): void {
    this.open?.finish({ kind: 'dismissed', reason: 'app' });
  }

  // MARK: Drawing

  private draw(open: Open, { campaign, rendered }: Presentation, answered: Answered, commented: Commented): void {
    const { template } = campaign;
    const content = isObject(campaign.raw.content) ? campaign.raw.content : {};
    const colors = isObject(content.colors) ? content.colors : {};
    const banner = BANNERS.includes(template);
    const blocking = !banner;

    const layer = this.element('div', `layer ${template}${banner ? ' banner' : ''}`);
    if (blocking && content.backdrop !== 'none') layer.classList.add('dim');
    const card = this.element('div', 'card');
    card.setAttribute('role', template === 'alert' ? 'alertdialog' : 'dialog');
    if (blocking) card.setAttribute('aria-modal', 'true');
    const background = color(colors.background);
    if (background) card.style.background = background;
    // Text and the close button turn light by themselves, unless a colour was given for them.
    if (background && isDark(background)) card.classList.add('dark');
    if (campaign.content.question) card.classList.add('asks');

    const image = template === 'alert' ? null : this.image(open, content);
    const tap = campaign.content.tapAction;
    const tapUrl = tap ? this.urlFor(campaign, rendered.urls, campaign.content.buttons.length) : null;
    const surface = IMAGE_ONLY.includes(template) ? image : card;
    if (tap && surface) this.tappable(open, surface, tap, tapUrl);
    if (image) card.appendChild(image);

    if (!IMAGE_ONLY.includes(template)) {
      const body = this.text(rendered.title, rendered.message, colors);
      const { question } = campaign.content;
      if (question) body.appendChild(this.question(open, body, question, answered, commented));
      if (body.firstChild) card.appendChild(body);
      const buttons = this.buttons(open, campaign, rendered, content);
      if (buttons) card.appendChild(buttons);
    }

    const label = rendered.title ?? rendered.message ?? 'Message';
    card.setAttribute('aria-label', label);
    const { dismissible } = campaign.content;
    if (dismissible && content.close_button !== false) {
      card.appendChild(this.closeButton(open));
      // Without a picture the button sits over the first line, so the text stops short of it.
      if (!image) card.classList.add('clear');
    }
    if (!image) card.classList.add('plain');

    if (blocking) {
      layer.addEventListener('click', (event) => {
        if (dismissible && event.target === layer) open.finish({ kind: 'dismissed', reason: 'backdrop' });
      });
      open.root.appendChild(this.sentinel(open, 'start'));
    }
    layer.appendChild(card);
    open.root.appendChild(layer);
    if (blocking) open.root.appendChild(this.sentinel(open, 'end'));
  }

  private text(title: string | null, message: string | null, colors: Json): HTMLElement {
    const body = this.element('div', 'body');
    if (title) {
      const heading = this.element('p', 'title');
      heading.textContent = title;
      const tint = color(colors.title);
      if (tint) heading.style.color = tint;
      body.appendChild(heading);
    }
    if (message) {
      const paragraph = this.element('p', 'message');
      paragraph.textContent = message;
      const tint = color(colors.message);
      if (tint) paragraph.style.color = tint;
      body.appendChild(paragraph);
    }
    return body;
  }

  // MARK: html pages

  /** Shown, and counted, once the page is ready and has a height; a full page needs only ready. */
  private drawPage(open: Open, campaign: Campaign, page: Page, drawn: () => void): void {
    const content = isObject(campaign.raw.content) ? campaign.raw.content : {};
    const layout = campaign.content.layout ?? 'modal';
    const banner = layout === 'banner_top' || layout === 'banner_bottom';
    const { dismissible } = campaign.content;
    const layer = this.element('div', `layer html ${layout} pending${banner ? ' banner' : ''}`);
    if (layout === 'modal' && content.backdrop !== 'none') layer.classList.add('dim');
    const card = this.element('div', 'card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Message');
    if (!banner) card.setAttribute('aria-modal', 'true');
    const close = this.closeButton(open);
    card.appendChild(close);
    if (layout === 'modal') {
      layer.addEventListener('click', (event) => {
        if (dismissible && event.target === layer) open.finish({ kind: 'dismissed', reason: 'backdrop' });
      });
    }
    if (!banner) open.root.appendChild(this.sentinel(open, 'start'));
    layer.appendChild(card);
    open.root.appendChild(layer);
    if (!banner) open.root.appendChild(this.sentinel(open, 'end'));

    const fail = (): void => open.finish({ kind: 'dismissed', reason: 'failed' });
    const deadline = setTimeout(() => {
      // Not eligible (e.g. a hidden tab): withdrawn, not a failure.
      if (!page.eligible()) return fail();
      this.logger.warn(`in_app.html_timeout: in-app message ${campaign.id} was not ready within 5 s`);
      fail();
    }, PAGE_DEADLINE);
    open.cleanup.push(() => clearTimeout(deadline));

    let ready = false;
    let tall = layout === 'full';
    const show = (frame: HtmlFrame): void => {
      if (frame.shown || !ready || !tall) return;
      if (!page.eligible()) return fail();
      frame.shown = true;
      clearTimeout(deadline);
      layer.classList.remove('pending');
      this.focus(open, banner, dismissible);
      drawn();
    };
    try {
      const frame: HtmlFrame = new HtmlFrame(
        this.doc,
        page.body,
        page,
        {
          ready: () => {
            ready = true;
            show(frame);
          },
          missing: () => open.finish({ kind: 'dismissed', reason: 'failed', missing: true }),
          height: (value) => {
            if (layout === 'full') return;
            frame.element.style.height = `${value}px`;
            tall ||= value > 0;
            show(frame);
          },
          close: () => open.finish({ kind: 'dismissed', reason: 'close_button' }),
          open: (url, active) => {
            if (!active) return this.logger.warn(`In-app page open ignored without a tap: ${url}`);
            this.act(open, null, { type: 'open_url', url }, url);
          },
          navigated: () => (frame.shown ? open.finish({ kind: 'dismissed', reason: 'app' }) : fail()),
        },
        this.logger,
      );
      open.cleanup.push(() => frame.destroy());
      card.insertBefore(frame.element, close);
    } catch {
      fail();
    }
  }

  // MARK: Questions

  private question(open: Open, body: HTMLElement, question: Question, answered: Answered, commented: Commented): HTMLElement {
    const box = this.element('div', `question ${question.type}`);
    const answer = (value: number | string): void => {
      if (open.answer) return;
      open.answer = { value, comment: null };
      this.call(() => answered(value));
      // Reporting the answer may have closed the message.
      if (this.open !== open) return;
      const { comment, thanks } = question;
      const above = typeof value === 'number' && typeof comment?.split === 'number' && value > comment.split;
      const prompt = above ? comment.high : comment?.low;
      if (prompt) this.comment(open, body, box, prompt, thanks, commented);
      else this.thank(open, body, thanks);
    };
    if (question.type === 'choice') {
      for (const { id, text } of question.options) box.appendChild(this.button('pick', text, () => answer(id)));
      return box;
    }
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Rating');
    for (let value = 1; value <= 5; value += 1) {
      const button = this.button('star', '', () => answer(value));
      button.setAttribute('aria-label', `${value} of 5`);
      box.appendChild(button);
    }
    return box;
  }

  private comment(open: Open, body: HTMLElement, box: HTMLElement, prompt: string, thanks: string | null, commented: Commented): void {
    const label = this.element('p', 'message');
    label.textContent = prompt;
    const input = this.doc.createElement('textarea');
    input.className = 'input';
    // UTF-16 units, as the contract measures: what maxLength and slice() count.
    input.maxLength = COMMENT_MAX;
    input.setAttribute('aria-label', prompt);
    const end = (text: string): void => {
      const comment = text.trim().slice(0, COMMENT_MAX) || null;
      if (open.answer) open.answer.comment = comment;
      if (comment) this.call(() => commented(comment));
      // Reporting the comment may have closed the message.
      if (this.open !== open) return;
      this.thank(open, body, thanks);
    };
    const row = this.element('div', 'buttons');
    row.append(
      this.button('button', 'Send', () => end(input.value)),
      this.button('button', 'Skip', () => end('')),
    );
    box.className = 'question';
    box.replaceChildren(label, input, row);
    input.focus();
  }

  private thank(open: Open, body: HTMLElement, thanks: string | null): void {
    const close = (): void => {
      if (open.answer) open.finish({ kind: 'answered', ...open.answer });
    };
    if (!thanks) return close();
    const line = this.element('p', 'message');
    line.textContent = thanks;
    line.setAttribute('role', 'status');
    line.setAttribute('aria-live', 'polite');
    line.tabIndex = -1;
    body.replaceChildren(line);
    // The button that held the focus is gone; focus on the thanks has it read out even where a
    // live region inserted with its text already in it is not.
    line.focus();
    const timer = setTimeout(close, THANKS_MS);
    open.cleanup.push(() => clearTimeout(timer));
  }

  /** A throwing callback must not leave the question stuck on screen. */
  private call(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.logger.warn(`In-app callback threw; ignored: ${String(error)}`);
    }
  }

  private button(className: string, text: string, run: () => void): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.className = className;
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', run);
    return button;
  }

  private buttons(open: Open, campaign: Campaign, rendered: Presentation['rendered'], content: Json): HTMLElement | null {
    const defined = campaign.content.buttons;
    if (defined.length === 0) return null;
    const raw = Array.isArray(content.buttons) ? content.buttons : [];
    const row = this.element('div', 'buttons');
    defined.forEach((button, index) => {
      const element = this.doc.createElement('button');
      element.className = 'button';
      element.type = 'button';
      element.textContent = rendered.buttons[index] ?? button.text;
      const given: unknown = raw[index];
      const tints = isObject(given) && isObject(given.colors) ? given.colors : {};
      const background = color(tints.background);
      const foreground = color(tints.text);
      if (background) element.style.background = background;
      if (foreground) element.style.color = foreground;
      const url = this.urlFor(campaign, rendered.urls, index);
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        this.act(open, button.id, button.action, url);
      });
      row.appendChild(element);
    });
    return row;
  }

  /** The filled links are listed buttons first, then the tap action; `position` is the action's place in that order. */
  private urlFor(campaign: Campaign, urls: string[], position: number): string | null {
    const actions: (Action | null)[] = [...campaign.content.buttons.map((b) => b.action), campaign.content.tapAction];
    if (actions[position]?.type !== 'open_url') return null;
    const before = actions.slice(0, position).filter((action) => action?.type === 'open_url').length;
    return urls[before] ?? null;
  }

  private image(open: Open, content: Json): HTMLImageElement | null {
    const images = isObject(content.image) ? content.image : {};
    const portrait = typeof images.portrait === 'string' ? images.portrait : null;
    const landscape = typeof images.landscape === 'string' ? images.landscape : null;
    if (!portrait && !landscape) return null;

    const element = this.doc.createElement('img');
    element.className = 'media';
    element.alt = '';
    const win = this.doc.defaultView;
    const choose = (): void => {
      const wide = win ? win.innerWidth > win.innerHeight : false;
      const source = (wide ? landscape : portrait) ?? portrait ?? landscape;
      if (source && element.getAttribute('src') !== source) element.src = source;
    };
    choose();
    if (win && portrait && landscape) {
      win.addEventListener('resize', choose);
      open.cleanup.push(() => win.removeEventListener('resize', choose));
    }
    return element;
  }

  private tappable(open: Open, element: HTMLElement, action: Action, url: string | null): void {
    element.classList.add('tap');
    element.addEventListener('click', () => this.act(open, null, action, url));
    if (element.tagName !== 'IMG') return;
    element.tabIndex = 0;
    element.setAttribute('role', 'button');
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.act(open, null, action, url);
    });
  }

  private closeButton(open: Open): HTMLElement {
    const button = this.doc.createElement('button');
    button.className = 'close';
    button.type = 'button';
    button.textContent = '✕';
    button.setAttribute('aria-label', 'Close');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      open.finish({ kind: 'dismissed', reason: 'close_button' });
    });
    return button;
  }

  private act(open: Open, buttonId: string | null, action: Action, url: string | null): void {
    open.finish({ kind: 'clicked', buttonId, action });
    if (action.type !== 'open_url' || url === null) return;
    try {
      this.navigate(url);
    } catch (error) {
      this.logger.warn(`In-app link could not be opened: ${String(error)}`);
    }
  }

  // MARK: Focus and teardown

  private focus(open: Open, banner: boolean, dismissible: boolean): void {
    if (banner) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && dismissible) open.finish({ kind: 'dismissed', reason: 'close_button' });
    };
    this.doc.addEventListener('keydown', onKey);
    open.cleanup.push(() => this.doc.removeEventListener('keydown', onKey));
    // The card itself, not its first button: a ring round a button nobody chose looks like a fault.
    const card = open.root.querySelector<HTMLElement>('.card');
    card?.setAttribute('tabindex', '-1');
    card?.focus();
  }

  private focusables(root: ShadowRoot): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('button, textarea, iframe, [tabindex]')).filter(
      (element) => !element.classList.contains('sentinel') && !element.classList.contains('card'),
    );
  }

  /** Focus leaving the card in either direction lands on a sentinel, which sends it to the other end. */
  private sentinel(open: Open, edge: 'start' | 'end'): HTMLElement {
    const sentinel = this.element('div', 'sentinel');
    sentinel.tabIndex = 0;
    sentinel.addEventListener('focus', () => {
      const all = this.focusables(open.root);
      (edge === 'start' ? all[all.length - 1] : all[0])?.focus();
    });
    return sentinel;
  }

  private active(): HTMLElement | null {
    let element = this.doc.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element instanceof HTMLElement ? element : null;
  }

  private close(open: Open): void {
    for (const undo of open.cleanup) undo();
    open.host.remove();
    if (this.open === open) this.open = null;
    if (open.restore?.isConnected) open.restore.focus();
  }

  private element(tag: 'div' | 'p', className: string): HTMLElement {
    const element = this.doc.createElement(tag);
    element.className = className;
    return element;
  }

  /** A constructed stylesheet is CSSOM, which a style-src policy does not govern; a <style> element is the fallback. */
  private style(root: ShadowRoot): void {
    const win = this.doc.defaultView;
    try {
      if (win && 'adoptedStyleSheets' in root && 'replaceSync' in win.CSSStyleSheet.prototype) {
        if (!this.sheet) {
          const sheet = new win.CSSStyleSheet();
          sheet.replaceSync(CSS);
          this.sheet = sheet;
        }
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.sheet];
        return;
      }
    } catch {
      /* fall through to the element */
    }
    const style = this.doc.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
  }
}
