import { isHttpUrl, type SmartBannerConfig } from './types';

export const HOST_ID = 'grovs-smart-banner';
const TOP_VAR = '--grovs-smart-banner-top';
const BOTTOM_VAR = '--grovs-smart-banner-bottom';

const CSS = `
:host{all:initial;display:block}
.bar{box-sizing:border-box;width:100%;display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--sb-bg);color:var(--sb-fg);font:14px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.bar.bottom{position:fixed;left:0;right:0;bottom:0;z-index:2147483646;padding-bottom:calc(10px + env(safe-area-inset-bottom))}
.close{all:unset;cursor:pointer;font-size:20px;width:44px;line-height:44px;margin:-2px 0 -2px -12px;text-align:center;opacity:.6;color:inherit}
.close:focus-visible{outline:2px solid;opacity:1}
img{width:40px;height:40px;border-radius:9px;flex:none;object-fit:cover}
.text{flex:1;min-width:0;display:flex;flex-direction:column}
.title{font-weight:600}
.title,.subtitle{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.subtitle{font-size:12px;opacity:.8}
.button{flex:none;padding:7px 14px;border-radius:999px;background:var(--sb-btn);color:var(--sb-btn-fg);font-weight:600;text-decoration:none}
`;

export interface BannerViewHandlers {
  onClick: () => void;
  onClose: () => void;
}

export class BannerView {
  private readonly host: HTMLElement;
  /** Measured instead of the host: a fixed bottom bar gives the host no height. */
  private readonly bar: HTMLElement;
  private readonly button: HTMLAnchorElement;
  private frame: number | null = null;
  private offsets = '';
  private readonly onScroll = (): void => {
    const win = this.doc.defaultView;
    if (this.frame !== null || !win) return;
    this.frame = win.requestAnimationFrame(() => {
      this.frame = null;
      this.updateOffsets();
    });
  };

  constructor(
    private readonly doc: Document,
    readonly banner: SmartBannerConfig,
    handlers: BannerViewHandlers,
  ) {
    this.host = doc.createElement('div');
    this.host.id = HOST_ID;
    this.host.style.setProperty('--sb-bg', banner.backgroundColor);
    this.host.style.setProperty('--sb-fg', banner.textColor);
    this.host.style.setProperty('--sb-btn', banner.buttonColor);
    this.host.style.setProperty('--sb-btn-fg', banner.buttonTextColor);

    const root = this.host.attachShadow({ mode: 'open' });
    this.installStyles(root);

    const bar = this.el('div', `bar ${banner.position}`);
    this.bar = bar;
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', banner.title);
    const close = this.el('button', 'close') as HTMLButtonElement;
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => handlers.onClose());
    bar.appendChild(close);

    if (isHttpUrl(banner.iconUrl)) {
      const icon = this.el('img', '') as HTMLImageElement;
      icon.src = banner.iconUrl;
      icon.alt = '';
      bar.appendChild(icon);
    }

    const text = this.el('div', 'text');
    const title = this.el('span', 'title');
    title.textContent = banner.title;
    text.appendChild(title);
    if (banner.subtitle) {
      const subtitle = this.el('span', 'subtitle');
      subtitle.textContent = banner.subtitle;
      text.appendChild(subtitle);
    }
    bar.appendChild(text);

    // A real anchor in the same tab: universal and app links need a user-initiated navigation.
    this.button = this.el('a', 'button') as HTMLAnchorElement;
    this.button.href = banner.defaultLink;
    this.button.textContent = banner.buttonText;
    this.button.addEventListener('click', () => handlers.onClick());
    bar.appendChild(this.button);

    root.appendChild(bar);
  }

  mount(): void {
    const body = this.doc.body;
    if (this.banner.position === 'top') body.insertBefore(this.host, body.firstChild);
    else body.appendChild(this.host);
    this.updateOffsets();
    const win = this.doc.defaultView;
    // A fixed bottom bar does not move on scroll.
    if (this.banner.position === 'top') win?.addEventListener('scroll', this.onScroll, { passive: true });
    win?.addEventListener('resize', this.onScroll, { passive: true });
  }

  setHref(link: string): void {
    this.button.href = link;
  }

  get href(): string {
    return this.button.getAttribute('href') ?? '';
  }

  /** False once something outside the SDK (a Turbo/pjax body swap) removed the host. */
  isConnected(): boolean {
    return this.host.isConnected;
  }

  remove(): void {
    const win = this.doc.defaultView;
    win?.removeEventListener('scroll', this.onScroll);
    win?.removeEventListener('resize', this.onScroll);
    if (this.frame !== null) win?.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.host.remove();
    const style = this.doc.documentElement.style;
    style.removeProperty(TOP_VAR);
    style.removeProperty(BOTTOM_VAR);
  }

  private updateOffsets(): void {
    const box = this.bar.getBoundingClientRect();
    const top = this.banner.position === 'top';
    const topPx = top ? Math.max(0, Math.min(box.height, box.bottom)) : 0;
    const bottomPx = top ? 0 : box.height;
    const offsets = `${topPx}:${bottomPx}`;
    // Writing a root custom property restyles the whole page, so skip unchanged values.
    if (offsets === this.offsets) return;
    this.offsets = offsets;
    const style = this.doc.documentElement.style;
    style.setProperty(TOP_VAR, `${topPx}px`);
    style.setProperty(BOTTOM_VAR, `${bottomPx}px`);
  }

  private el(tag: string, className: string): HTMLElement {
    const element = this.doc.createElement(tag);
    if (className) element.className = className;
    return element;
  }

  /** Constructed sheet first: a style-src CSP blocks an injected <style>. */
  private installStyles(root: ShadowRoot): void {
    const win = this.doc.defaultView;
    try {
      if (win && 'adoptedStyleSheets' in root && 'replaceSync' in win.CSSStyleSheet.prototype) {
        const sheet = new win.CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
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
