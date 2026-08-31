import type { Logger } from '../logging/logger';
import type { GrovsMessage, MessagesService } from './messages';

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

  constructor(
    private readonly doc: Document,
    private readonly service: MessagesService,
    private readonly logger: Logger,
  ) {}

  async showMessagesList(): Promise<void> {
    if (this.doc.getElementById(LIST_MODAL_ID)) return;

    const host = this.doc.createElement('div');
    host.id = LIST_MODAL_ID;
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : null;

    const overlay = this.doc.createElement('div');
    overlay.className = 'grovs-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '15%',
      left: '15%',
      width: '70%',
      height: '70%',
      zIndex: '1000',
      overflow: 'hidden',
      borderRadius: '30px',
      padding: '30px',
      boxSizing: 'border-box',
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      color: 'white',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    });

    const header = this.doc.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      height: '40px',
      marginBottom: '20px',
    });

    const heading = this.doc.createElement('strong');
    heading.textContent = 'Messages';
    header.appendChild(heading);

    const closeButton = this.doc.createElement('button');
    closeButton.textContent = '✕';
    Object.assign(closeButton.style, {
      background: 'transparent',
      border: 'none',
      color: 'white',
      cursor: 'pointer',
      fontSize: '18px',
    });
    closeButton.addEventListener('click', () => this.close());
    header.appendChild(closeButton);

    const list = this.doc.createElement('div');
    list.className = 'grovs-item-list';
    Object.assign(list.style, { overflowY: 'auto', height: 'calc(100% - 60px)' });

    overlay.appendChild(header);
    overlay.appendChild(list);

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.close();
    });

    list.addEventListener('scroll', () => {
      if (this.isLoading || this.exhausted) return;
      const scrolled = list.scrollTop;
      const scrollable = list.scrollHeight - list.clientHeight;
      if (scrollable > 0 && scrolled >= scrollable / 2) {
        this.page += 1;
        void this.loadMessages();
      }
    });

    if (root) root.appendChild(overlay);
    else host.appendChild(overlay);
    this.doc.body.appendChild(host);

    this.host = host;
    this.overlay = overlay;
    this.listElement = list;
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
    Object.assign(modal.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      zIndex: '1002',
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
    });

    const header = this.doc.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '10px',
      color: 'white',
      height: '20px',
    });

    const title = this.doc.createElement('h2');
    title.textContent = message.title;
    header.appendChild(title);

    const close = this.doc.createElement('button');
    close.textContent = '✕';
    Object.assign(close.style, {
      background: 'transparent',
      border: 'none',
      color: 'white',
      cursor: 'pointer',
    });
    close.addEventListener('click', () => {
      modal.remove();
      this.ownModals.delete(modal);
    });
    header.appendChild(close);

    const frame = this.doc.createElement('iframe');
    // Notification content is remote and rendered inside the customer's page.
    // Sandboxing without allow-same-origin denies it access to the embedding
    // document, and the scheme check keeps javascript:/data: URLs out.
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = safeUrl(message.access_url);
    Object.assign(frame.style, {
      width: '100%',
      height: 'calc(100% - 40px)',
      border: 'none',
    });

    modal.appendChild(header);
    modal.appendChild(frame);
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
      empty.textContent = 'No messages yet.';
      empty.style.padding = '20px';
      list.appendChild(empty);
      return;
    }

    for (const message of messages) list.appendChild(this.renderRow(message));
    this.logger.info(`Rendered ${messages.length} message(s) on page ${this.page}.`);
  }

  private renderRow(message: GrovsMessage): HTMLElement {
    const row = this.doc.createElement('div');
    row.className = 'grovs-item';
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      padding: '20px',
      borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
      cursor: 'pointer',
    });

    const indicator = this.doc.createElement('div');
    Object.assign(indicator.style, {
      width: '10px',
      height: '10px',
      borderRadius: '50%',
      marginRight: '10px',
      backgroundColor: 'white',
      display: message.read ? 'none' : 'block',
      flexShrink: '0',
    });

    const text = this.doc.createElement('div');
    const title = this.doc.createElement('strong');
    title.className = 'grovs-item-title';
    title.textContent = message.title;
    const subtitle = this.doc.createElement('span');
    subtitle.className = 'grovs-item-subtitle';
    subtitle.textContent = message.subtitle;
    text.appendChild(title);
    text.appendChild(this.doc.createElement('br'));
    text.appendChild(subtitle);

    row.appendChild(indicator);
    row.appendChild(text);
    row.addEventListener('click', () => this.openPage(message));

    return row;
  }
}
