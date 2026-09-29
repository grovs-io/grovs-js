import type { Logger } from '../logging/logger';
import type { Outcome, Presentation, Presenter } from './controller';
import type { Action, Campaign } from './types';

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
.dark .title, .dark .message { color: #ffffff; }
.dark.clear .close, .banner .dark .close { background: rgba(255, 255, 255, 0.16); color: #ffffff; }
.banner .close { top: 50%; margin-top: -14px; }
.button:focus-visible, .close:focus-visible, .tap:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
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
}

export class InAppRenderer implements Presenter {
  private open: Open | null = null;
  private sheet: CSSStyleSheet | null = null;

  constructor(
    private readonly doc: Document,
    private readonly logger: Logger,
    private readonly navigate: (url: string) => void,
  ) {}

  present(presentation: Presentation, drawn: () => void = () => undefined): Promise<Outcome> {
    this.dismiss();
    if (!this.doc.body) return Promise.reject(new Error('the page has no body'));
    return new Promise((resolve) => {
      const host = this.doc.createElement('div');
      host.id = HOST_ID;
      const root = host.attachShadow({ mode: 'open' });
      const open: Open = { host, root, restore: this.active(), cleanup: [], finish: () => undefined };
      let done = false;
      open.finish = (outcome) => {
        if (done) return;
        done = true;
        this.close(open);
        resolve(outcome);
      };
      this.open = open;
      this.style(root);
      this.draw(open, presentation);
      this.doc.body.appendChild(host);
      // Focus first: the host may close the message from onShown, and close() must find every listener to remove.
      this.focus(open, presentation.campaign);
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

  private draw(open: Open, { campaign, rendered }: Presentation): void {
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

    const image = template === 'alert' ? null : this.image(open, content);
    const tap = campaign.content.tapAction;
    const tapUrl = tap ? this.urlFor(campaign, rendered.urls, campaign.content.buttons.length) : null;
    const surface = IMAGE_ONLY.includes(template) ? image : card;
    if (tap && surface) this.tappable(open, surface, tap, tapUrl);
    if (image) card.appendChild(image);

    if (!IMAGE_ONLY.includes(template)) {
      const body = this.text(rendered.title, rendered.message, colors);
      if (body) card.appendChild(body);
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

  private text(title: string | null, message: string | null, colors: Json): HTMLElement | null {
    if (!title && !message) return null;
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

  private focus(open: Open, campaign: Campaign): void {
    if (BANNERS.includes(campaign.template)) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && campaign.content.dismissible) open.finish({ kind: 'dismissed', reason: 'close_button' });
    };
    this.doc.addEventListener('keydown', onKey);
    open.cleanup.push(() => this.doc.removeEventListener('keydown', onKey));
    // The card itself, not its first button: a ring round a button nobody chose looks like a fault.
    const card = open.root.querySelector<HTMLElement>('.card');
    card?.setAttribute('tabindex', '-1');
    card?.focus();
  }

  private focusables(root: ShadowRoot): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('button, [tabindex]')).filter(
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
