import type { Logger } from '../logging/logger';
import type { GrovsMessage, MessagesService } from './messages';
import {
  buildStylesheet,
  hostDataAttributes,
  resolveTheme,
  type MessagesTheme,
  type ResolvedMessagesTheme,
} from './messages-theme';

const LIST_MODAL_ID = 'Grovs-modal';
const PAGE_MODAL_ID = 'Grovs-page-modal';
const PAGE_MODAL_CLASS = 'grovs-page-modal';
/** More than a few stacked modals is a misconfiguration, not a campaign. */
const MAX_AUTOMATIC_MESSAGES = 5;

/**
 * Absolute http(s) URLs only. Notification#access_url arrives scheme-less
 * and iOS prepends https:// (MessageDetailsViewController.swift:66), so the
 * same happens here. A non-http(s) scheme either fails to parse or
 * re-anchors to a remote host — never the embedding origin.
 */
function safeUrl(url: string): string {
  const candidate = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : 'about:blank';
  } catch {
    return 'about:blank';
  }
}

/**
 * The messages modal, rendered into a shadow root.
 *
 * v1 injected a raw HTML string plus a Google Fonts <link> straight into the
 * host page, so it inherited whatever CSS the host had, leaked its own onto
 * the host, and added a third-party request on every open. A shadow root
 * isolates styles in both directions and the font goes.
 *
 * Three changes from v1, all defect fixes rather than redesign:
 *   - the debug `background = "red"` at grovs_ui_helper.js:240 is gone;
 *   - rows are built with createElement and textContent instead of innerHTML
 *     interpolation, so a message title cannot inject markup into the host
 *     page — v1 interpolated item.title and item.subtitle straight into a
 *     template literal assigned to innerHTML;
 *   - the list element is held explicitly. v1 referenced an undeclared
 *     `itemList` binding at grovs_ui_helper.js:360 and only worked because
 *     browsers expose elements with an id as named properties of window.
 */
export class MessagesUI {
  private page = 1;
  private isLoading = false;
  /** Stops the scroll handler refetching for ever once the list is exhausted. */
  private exhausted = false;
  private listElement: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  /** Only the modals this instance opened — the v1 shim builds its own UI,
   *  and close() must not reach across and remove that one's. */
  private readonly ownModals = new Set<HTMLElement>();
  private unread = 0;
  /** Set once the server total lands: it covers pages that were never loaded,
   *  so the per-row tally must stop adding to it. */
  private unreadFromServer = false;
  private badge: HTMLElement | null = null;
  /** A repeated page reads as exhaustion instead of looping the auto-fill. */
  private readonly renderedIds = new Set<number>();
  private keyListener: ((event: KeyboardEvent) => void) | null = null;
  /** Where focus was before each modal opened, so closing gives it back. */
  private readonly returnFocus = new Map<HTMLElement, HTMLElement | null>();
  private readonly theme: ResolvedMessagesTheme;
  /** Parsed once; adopted by every modal root. */
  private sheet: CSSStyleSheet | null = null;

  constructor(
    private readonly doc: Document,
    private readonly service: MessagesService,
    private readonly logger: Logger,
    theme?: MessagesTheme,
  ) {
    this.theme = resolveTheme(theme, (message) => this.logger.warn(message));
  }

  /** Shadow root with the theme stylesheet installed. */
  private themedRoot(host: HTMLElement): ShadowRoot {
    for (const [name, value] of Object.entries(hostDataAttributes(this.theme))) {
      host.setAttribute(name, value);
    }
    const root = host.attachShadow({ mode: 'open' });
    const css = buildStylesheet(this.theme);
    // A constructed stylesheet is CSSOM, which a style-src policy does not
    // govern; an injected <style> is blocked by any policy without
    // 'unsafe-inline'. Falls back where the API is missing.
    const win = this.doc.defaultView;
    try {
      if (win && 'adoptedStyleSheets' in root && 'replaceSync' in win.CSSStyleSheet.prototype) {
        if (!this.sheet) {
          // Cached only once it holds the rules: assigning first meant a
          // throw from replaceSync left an empty sheet in the cache, and
          // every later modal adopted it and rendered unstyled.
          const sheet = new win.CSSStyleSheet();
          sheet.replaceSync(css);
          this.sheet = sheet;
        }
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.sheet];
        return root;
      }
    } catch {
      /* fall through to the element */
    }
    const style = this.doc.createElement('style');
    style.textContent = css;
    root.appendChild(style);
    return root;
  }

  private ensureKeyListener(): void {
    if (this.keyListener) return;
    const onKey = (event: KeyboardEvent) => {
      const top = this.topModal();
      if (!top) {
        this.releaseKeyListenerIfIdle();
        return;
      }
      if (event.key !== 'Escape') return;
      if (top !== this.host) this.closeDetail(top);
      else this.close();
    };
    this.doc.addEventListener('keydown', onKey);
    this.keyListener = onKey;
  }

  private releaseKeyListenerIfIdle(): void {
    if (this.host || this.ownModals.size > 0 || !this.keyListener) return;
    this.doc.removeEventListener('keydown', this.keyListener);
    this.keyListener = null;
  }

  /**
   * The modal focus belongs to: the newest detail, else the list. A host
   * framework that swaps <body> detaches modals without telling us, and a
   * trap on a detached modal would cancel every Tab on the page — so the
   * detached are forgotten here.
   */
  private topModal(): HTMLElement | null {
    for (const modal of this.ownModals) {
      if (!modal.isConnected) this.ownModals.delete(modal);
    }
    if (this.host && !this.host.isConnected) {
      // Forget it, do not close(): close() also removes the detail modals,
      // which are still on the page and still the visitor's, and hands focus
      // back to whatever the host page focused since.
      this.host = null;
      this.overlay = null;
      this.listElement = null;
      this.badge = null;
      this.releaseKeyListenerIfIdle();
    }
    return [...this.ownModals].pop() ?? this.host;
  }

  private focusables(root: ShadowRoot): HTMLElement[] {
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], iframe, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.classList.contains('grovs-sentinel'));
  }

  /** The element that held focus, reaching through shadow roots. */
  private activeElement(): HTMLElement | null {
    let element = this.doc.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element && typeof (element as HTMLElement).focus === 'function'
      ? (element as HTMLElement)
      : null;
  }

  /**
   * aria-modal promises the page behind is inert, and the browser does not
   * do that for a div. Two focusable sentinels bracket the card: sequential
   * focus leaving it in either direction lands on one, which hands focus to
   * the opposite end. This is the only mechanism that also covers a Tab
   * pressed inside the message iframe, which the host document never sees —
   * and it cancels nothing, so a modal the host page detaches cannot swallow
   * keys.
   */
  private sentinel(root: ShadowRoot, edge: 'start' | 'end'): HTMLElement {
    const sentinel = this.doc.createElement('div');
    sentinel.className = 'grovs-sentinel';
    sentinel.tabIndex = 0;
    // Property assignments, not a style attribute: CSP's style-src blocks the
    // attribute form but not CSSOM. No aria-hidden — a focusable hidden
    // element is what accessibility audits flag.
    sentinel.style.position = 'fixed';
    sentinel.style.width = '1px';
    sentinel.style.height = '1px';
    sentinel.style.opacity = '0';
    sentinel.style.pointerEvents = 'none';
    sentinel.addEventListener('focus', () => {
      const focusable = this.focusables(root);
      (edge === 'start' ? focusable[focusable.length - 1] : focusable[0])?.focus();
    });
    return sentinel;
  }

  /** Resolves true once <body> exists; false only when the document never
   *  finishes parsing (it is being torn down). */
  private bodyReady(): Promise<boolean> {
    if (this.doc.body) return Promise.resolve(true);
    // Parsed and still no body: it is not coming.
    if (this.doc.readyState !== 'loading') return Promise.resolve(false);
    return new Promise((resolve) => {
      this.doc.addEventListener('DOMContentLoaded', () => resolve(this.doc.body !== null), {
        once: true,
      });
    });
  }

  private takeFocus(modal: HTMLElement, target: HTMLElement): void {
    this.returnFocus.set(modal, this.activeElement());
    target.focus();
  }

  private giveFocusBack(modal: HTMLElement): void {
    const previous = this.returnFocus.get(modal) ?? null;
    this.returnFocus.delete(modal);
    if (previous?.isConnected) previous.focus();
  }

  private closeDetail(modal: HTMLElement): void {
    modal.remove();
    this.ownModals.delete(modal);
    this.giveFocusBack(modal);
    this.releaseKeyListenerIfIdle();
  }

  private closeButton(onClose: () => void): HTMLElement {
    const button = this.doc.createElement('button');
    button.className = 'grovs-close';
    button.textContent = '✕';
    button.setAttribute('aria-label', 'Close');
    button.addEventListener('click', onClose);
    return button;
  }

  async showMessagesList(): Promise<void> {
    if (!this.service.canShowUI) {
      this.logger.warn('showMessagesList() ignored: the SDK is disabled.');
      return;
    }
    if (this.doc.getElementById(LIST_MODAL_ID)) return;
    const valid = this.service.uiGuard();
    if (!(await this.bodyReady()) || !valid()) return;
    if (this.doc.getElementById(LIST_MODAL_ID)) return;

    const host = this.doc.createElement('div');
    host.id = LIST_MODAL_ID;
    const root = this.themedRoot(host);

    const backdrop = this.doc.createElement('div');
    backdrop.className = 'grovs-backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) this.close();
    });

    const card = this.doc.createElement('div');
    card.className = 'grovs-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', this.theme.title);

    const header = this.doc.createElement('div');
    header.className = 'grovs-header';

    const heading = this.doc.createElement('span');
    heading.className = 'grovs-heading';
    heading.textContent = this.theme.title;

    const badge = this.doc.createElement('span');
    badge.className = 'grovs-badge';
    badge.setAttribute('data-count', '0');

    const closeButton = this.closeButton(() => this.close());
    header.appendChild(heading);
    header.appendChild(badge);
    header.appendChild(closeButton);

    const list = this.doc.createElement('div');
    list.className = 'grovs-item-list';

    list.addEventListener('scroll', () => {
      if (this.isLoading || this.exhausted) return;
      const scrolled = list.scrollTop;
      const scrollable = list.scrollHeight - list.clientHeight;
      if (scrollable > 0 && scrolled >= scrollable / 2) {
        this.page += 1;
        void this.loadMessages();
      }
    });

    card.appendChild(this.sentinel(root, 'start'));
    card.appendChild(header);
    card.appendChild(list);
    card.appendChild(this.sentinel(root, 'end'));
    backdrop.appendChild(card);
    root.appendChild(backdrop);
    this.doc.body.appendChild(host);

    this.host = host;
    this.overlay = backdrop;
    this.listElement = list;
    this.badge = badge;
    this.unread = 0;
    this.unreadFromServer = false;
    this.renderedIds.clear();
    this.page = 1;
    this.isLoading = false;
    this.exhausted = false;
    this.ensureKeyListener();
    this.takeFocus(host, closeButton);

    await this.loadMessages();
    // The server total covers unloaded pages; the per-row tally set during
    // rendering stays when the request fails or a newer open owns the badge.
    const serverCount = await this.service.fetchUnreadCount();
    if (serverCount !== null && this.badge === badge) {
      this.setUnread(serverCount);
      this.unreadFromServer = true;
    }
  }

  openPage(message: GrovsMessage): void {
    // Automatic display can open several at once, so they cannot share an id:
    // each modal takes its message's id, and reopening the same message
    // focuses nothing new rather than stacking a duplicate.
    //
    // The guard is document-scoped on purpose, unlike ownModals: an id is a
    // document-wide invariant, so if another instance's modal holds it —
    // possible only if the configure() close-before-replace ordering ever
    // changes — the right move is still to not mint a duplicate.
    const modalId = `${PAGE_MODAL_ID}-${message.id}`;
    if (!this.service.canShowUI || this.doc.getElementById(modalId)) return;
    if (!this.doc.body) {
      if (this.doc.readyState !== 'loading') return;
      // configure() in <head> with a fast backend: no body to render into
      // yet. A reset meanwhile makes this the previous visitor's message.
      const valid = this.service.uiGuard();
      this.doc.addEventListener(
        'DOMContentLoaded',
        () => {
          if (valid()) this.openPage(message);
        },
        { once: true },
      );
      return;
    }

    const modal = this.doc.createElement('div');
    modal.id = modalId;
    modal.className = PAGE_MODAL_CLASS;
    const root = this.themedRoot(modal);

    const backdrop = this.doc.createElement('div');
    backdrop.className = 'grovs-backdrop grovs-detail';
    // Detail modals stack above the list.
    backdrop.style.zIndex = 'calc(var(--grovs-z) + 2)';

    const card = this.doc.createElement('div');
    card.className = 'grovs-card grovs-detail-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', message.title);

    const header = this.doc.createElement('div');
    header.className = 'grovs-header';
    const heading = this.doc.createElement('span');
    heading.className = 'grovs-heading';
    heading.textContent = message.title;
    header.appendChild(heading);
    const closeButton = this.closeButton(() => this.closeDetail(modal));
    header.appendChild(closeButton);

    const frame = this.doc.createElement('iframe');
    // Notification content is remote and rendered inside the customer's page.
    // Sandboxing without allow-same-origin denies it access to the embedding
    // document, and the scheme check keeps javascript:/data: URLs out.
    // allow-popups-to-escape-sandbox: without it a target="_blank" link out of
    // a message opens its destination with an opaque origin, where storage
    // access throws — so a login or checkout page opened from a message
    // simply breaks. The frame itself stays sandboxed, and without
    // allow-same-origin it still cannot reach the embedding document.
    frame.setAttribute(
      'sandbox',
      'allow-scripts allow-popups allow-forms allow-popups-to-escape-sandbox',
    );
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.className = 'grovs-frame';
    frame.src = safeUrl(message.access_url);

    card.appendChild(this.sentinel(root, 'start'));
    card.appendChild(header);
    card.appendChild(frame);
    card.appendChild(this.sentinel(root, 'end'));
    backdrop.appendChild(card);
    root.appendChild(backdrop);
    this.doc.body.appendChild(modal);
    this.ownModals.add(modal);
    this.ensureKeyListener();
    this.takeFocus(modal, closeButton);

    void this.service.markMessageAsRead(message.id);
  }

  close(): void {
    if (this.keyListener) {
      this.doc.removeEventListener('keydown', this.keyListener);
      this.keyListener = null;
    }
    // Back to where the visitor was before the first of these opened,
    // whatever was stacked on top of it since: the list if there is one,
    // else the oldest detail (automatic display opens those alone).
    const [oldest] = this.ownModals;
    const origin = this.host ?? oldest ?? null;
    for (const modal of this.ownModals) modal.remove();
    this.ownModals.clear();
    this.host?.remove();
    this.host = null;
    if (origin) this.giveFocusBack(origin);
    this.returnFocus.clear();
    this.overlay = null;
    this.listElement = null;
    this.badge = null;
    this.unread = 0;
    this.unreadFromServer = false;
  }

  /**
   * Opens every message the console flagged for automatic display.
   *
   * v1 implemented this and commented the body out
   * (grovs_manager.js:229-242); iOS ships it working.
   */
  async displayAutomaticMessages(): Promise<void> {
    const messages = await this.service.messagesForAutomaticDisplay();
    // Capped: each one is a modal, a remote iframe and a mark-as-read
    // request, and nothing on the response side bounds the list. A console
    // misconfiguration should cost a few modals, not the page.
    const shown = messages.slice(0, MAX_AUTOMATIC_MESSAGES);
    if (messages.length > shown.length) {
      this.logger.warn(
        `${messages.length} messages are flagged for automatic display; showing ` +
          `the first ${MAX_AUTOMATIC_MESSAGES}.`,
      );
    }
    for (const message of shown) this.openPage(message);
  }

  private async loadMessages(): Promise<void> {
    const list = this.listElement;
    if (!list) return;

    this.isLoading = true;
    if (this.page === 1) {
      list.replaceChildren();
      for (let i = 0; i < 3; i += 1) {
        const skeleton = this.doc.createElement('div');
        skeleton.className = 'grovs-skeleton';
        skeleton.appendChild(this.doc.createElement('div'));
        skeleton.appendChild(this.doc.createElement('div'));
        list.appendChild(skeleton);
      }
    }
    const messages = await this.service.fetchMessages(this.page);

    // Before any state is touched: the modal may have closed while this was in
    // flight, and `isLoading` and `exhausted` belong to whatever list replaced
    // it — an empty final page would strand the new one on page one.
    if (this.listElement !== list) return;

    this.isLoading = false;

    // null is "the request failed", which the array return cannot express.
    // Reading it as "no messages" told the visitor their inbox was empty when
    // the network was down, and marked a list exhausted that had never loaded.
    if (messages === null) {
      if (this.page === 1) {
        list.replaceChildren();
        const failed = this.doc.createElement('div');
        failed.className = 'grovs-empty';
        failed.textContent = 'Messages could not be loaded.';
        list.appendChild(failed);
      }
      // Give the page back: the scroll handler's increment then retries the
      // page that failed instead of skipping past it.
      this.page -= 1;
      return;
    }

    if (messages.length === 0) this.exhausted = true;

    if (this.page === 1) list.replaceChildren();

    if (messages.length === 0 && this.page === 1) {
      const empty = this.doc.createElement('div');
      empty.className = 'grovs-empty';
      // DOM APIs, not innerHTML: a Trusted Types policy rejects the string
      // form even for static markup.
      const svgNs = 'http://www.w3.org/2000/svg';
      const icon = this.doc.createElementNS(svgNs, 'svg');
      for (const [name, value] of [
        ['width', '28'],
        ['height', '28'],
        ['viewBox', '0 0 24 24'],
        ['fill', 'none'],
        ['stroke', 'currentColor'],
        ['stroke-width', '1.5'],
        ['aria-hidden', 'true'],
      ]) {
        icon.setAttribute(name!, value!);
      }
      for (const d of ['M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8', 'M10 21h4']) {
        const path = this.doc.createElementNS(svgNs, 'path');
        path.setAttribute('d', d);
        icon.appendChild(path);
      }
      empty.appendChild(icon);
      empty.appendChild(this.doc.createTextNode('No messages yet.'));
      list.appendChild(empty);
      return;
    }

    const fresh = messages.filter((message) => !this.renderedIds.has(message.id));
    if (fresh.length === 0) {
      if (messages.length > 0) {
        this.logger.info(
          `Page ${this.page} contained only already-rendered messages; treating the list as exhausted.`,
        );
      }
      this.exhausted = true;
      return;
    }

    for (const message of fresh) {
      this.renderedIds.add(message.id);
      // Only until the server total arrives; it already counts the pages that
      // are not loaded yet, so adding to it overshoots.
      if (!message.read && !this.unreadFromServer) this.setUnread(this.unread + 1);
      list.appendChild(this.renderRow(message));
    }
    this.logger.info(`Rendered ${fresh.length} message(s) on page ${this.page}.`);

    // A short first page has no scrollbar, so scroll-driven pagination would
    // stall; clientHeight > 0 skips a list with no layout. Terminates because
    // every fresh row grows scrollHeight (page CSS cannot reach into the
    // shadow root) until overflow; exhaustion and the dedupe cover the rest.
    if (!this.exhausted && list.clientHeight > 0 && list.scrollHeight <= list.clientHeight) {
      this.page += 1;
      await this.loadMessages();
    }
  }

  private setUnread(count: number): void {
    this.unread = count;
    if (!this.badge) return;
    this.badge.textContent = String(count);
    this.badge.setAttribute('data-count', String(count));
  }

  private renderRow(message: GrovsMessage): HTMLElement {
    const row = this.doc.createElement('div');
    row.className = 'grovs-item';
    row.setAttribute('data-read', String(message.read));
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        row.click();
      }
    });

    const dot = this.doc.createElement('div');
    dot.className = 'grovs-dot';

    const text = this.doc.createElement('div');
    const title = this.doc.createElement('strong');
    title.className = 'grovs-item-title';
    title.textContent = message.title;
    const subtitle = this.doc.createElement('span');
    subtitle.className = 'grovs-item-subtitle';
    subtitle.textContent = message.subtitle;
    text.appendChild(title);
    text.appendChild(subtitle);

    row.appendChild(dot);
    row.appendChild(text);
    row.addEventListener('click', () => {
      if (row.getAttribute('data-read') !== 'true') {
        row.setAttribute('data-read', 'true');
        this.setUnread(Math.max(0, this.unread - 1));
      }
      this.openPage(message);
    });

    return row;
  }
}
