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

/**
 * Refuses anything that is not an absolute http(s) URL.
 *
 * No base is supplied, so a relative value fails to parse rather than
 * resolving against the customer's own origin — which would let notification
 * content frame the embedding site.
 */
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : 'about:blank';
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
  private badge: HTMLElement | null = null;
  private readonly theme: ResolvedMessagesTheme;

  constructor(
    private readonly doc: Document,
    private readonly service: MessagesService,
    private readonly logger: Logger,
    theme?: MessagesTheme,
  ) {
    this.theme = resolveTheme(theme, (message) => this.logger.warn(message));
  }

  /** Shadow root (or host fallback) with the theme stylesheet installed. */
  private themedRoot(host: HTMLElement): ShadowRoot | HTMLElement {
    for (const [name, value] of Object.entries(hostDataAttributes(this.theme))) {
      host.setAttribute(name, value);
    }
    const shadow = Boolean(host.attachShadow);
    const root: ShadowRoot | HTMLElement = shadow
      ? host.attachShadow({ mode: 'open' })
      : host;
    const style = this.doc.createElement('style');
    // No shadow root (ancient embedder): namespace under the host id and
    // accept minor host-CSS bleed, exactly as the old inline styles did.
    style.textContent = buildStylesheet(this.theme, shadow ? ':host' : `#${host.id}`);
    root.appendChild(style);
    return root;
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

    const header = this.doc.createElement('div');
    header.className = 'grovs-header';

    const heading = this.doc.createElement('span');
    heading.className = 'grovs-heading';
    heading.textContent = 'Messages';

    const badge = this.doc.createElement('span');
    badge.className = 'grovs-badge';
    badge.setAttribute('data-count', '0');

    header.appendChild(heading);
    header.appendChild(badge);
    header.appendChild(this.closeButton(() => this.close()));

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

    card.appendChild(header);
    card.appendChild(list);
    backdrop.appendChild(card);
    root.appendChild(backdrop);
    this.doc.body.appendChild(host);

    this.host = host;
    this.overlay = backdrop;
    this.listElement = list;
    this.badge = badge;
    this.unread = 0;
    this.page = 1;
    this.exhausted = false;

    await this.loadMessages();
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
    if (this.doc.getElementById(modalId)) return;

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

    const header = this.doc.createElement('div');
    header.className = 'grovs-header';
    const heading = this.doc.createElement('span');
    heading.className = 'grovs-heading';
    heading.textContent = message.title;
    header.appendChild(heading);
    header.appendChild(
      this.closeButton(() => {
        modal.remove();
        this.ownModals.delete(modal);
      }),
    );

    const frame = this.doc.createElement('iframe');
    // Notification content is remote and rendered inside the customer's page.
    // Sandboxing without allow-same-origin denies it access to the embedding
    // document, and the scheme check keeps javascript:/data: URLs out.
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.className = 'grovs-frame';
    frame.src = safeUrl(message.access_url);

    card.appendChild(header);
    card.appendChild(frame);
    backdrop.appendChild(card);
    root.appendChild(backdrop);
    this.doc.body.appendChild(modal);
    this.ownModals.add(modal);

    void this.service.markMessageAsRead(message.id);
  }

  close(): void {
    for (const modal of this.ownModals) modal.remove();
    this.ownModals.clear();
    this.host?.remove();
    this.host = null;
    this.overlay = null;
    this.listElement = null;
    this.badge = null;
    this.unread = 0;
  }

  /**
   * Opens every message the console flagged for automatic display.
   *
   * v1 implemented this and commented the body out
   * (grovs_manager.js:229-242); iOS ships it working.
   */
  async displayAutomaticMessages(): Promise<void> {
    const messages = await this.service.messagesForAutomaticDisplay();
    for (const message of messages) this.openPage(message);
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
    const messages = await this.service.getMessages(this.page);
    this.isLoading = false;
    if (messages.length === 0) this.exhausted = true;

    // The modal may have been closed, or the SDK disabled or reset, while the
    // request was in flight. Rendering into a detached list is harmless but
    // rendering into a live one after a stop is not.
    if (this.listElement !== list) return;

    if (this.page === 1) list.replaceChildren();

    if (messages.length === 0 && this.page === 1) {
      const empty = this.doc.createElement('div');
      empty.className = 'grovs-empty';
      // Static markup only — never interpolate message content here.
      empty.innerHTML =
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
        '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/>' +
        '<path d="M10 21h4"/></svg>No messages yet.';
      list.appendChild(empty);
      return;
    }

    for (const message of messages) {
      if (!message.read) this.setUnread(this.unread + 1);
      list.appendChild(this.renderRow(message));
    }
    this.logger.info(`Rendered ${messages.length} message(s) on page ${this.page}.`);
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
