import { GrovsClient, type ClientDeps } from '../core/client';
import { LinkGenerator } from '../links/links';
import { MessagesService, type GrovsMessage } from '../messages/messages';
import { MessagesUI } from '../messages/messages-ui';
import { getDocument } from '../core/environment';
import { Logger } from '../logging/logger';

type SuccessCallback<T> = (value: T) => void;
type ErrorCallback = (error: string) => void;

const warned = new Set<string>();

function deprecate(method: string, replacement: string): void {
  if (warned.has(method)) return;
  warned.add(method);
  console.warn(
    `Grovs — ${method}() is deprecated and will be removed in 3.0. Use ${replacement} instead. ` +
      'See MIGRATION.md.',
  );
}

/** Test seam so cases do not inherit each other's warning state. */
export function __resetDeprecationWarnings(): void {
  warned.clear();
}

/**
 * Two Grovs clients on one page is unsupported: each runs
 * its own authentication, launch events, timers and session, so everything is
 * counted twice. The v1 constructor and the v2 statics now share one export,
 * which makes mixing the eras easy to do by accident — so the first time both
 * are seen, say so. State lives here rather than in index.ts because index.ts
 * already imports this module and the reverse would be a cycle.
 */
let facadeConfigured = false;
let v1Constructed = false;
let coexistenceWarned = false;

function warnCoexistence(): void {
  if (!facadeConfigured || !v1Constructed || coexistenceWarned) return;
  coexistenceWarned = true;
  console.warn(
    'Grovs — both the v1 constructor and Grovs.configure() are in use on ' +
      'one page. They are separate clients: sessions, launch events and ' +
      'timers all run twice. Use one or the other. See MIGRATION.md.',
  );
}

/** Called by the facade's configure(), so the shim can detect coexistence. */
export function noteFacadeConfigured(): void {
  facadeConfigured = true;
  warnCoexistence();
}

/** Test seam: coexistence detection is module-level, like the store above. */
export function __resetCoexistenceState(): void {
  facadeConfigured = false;
  v1Constructed = false;
  coexistenceWarned = false;
}

/**
 * The v1 surface, preserved so no existing integrator breaks on upgrade.
 *
 * One behavioural difference is deliberate and documented in MIGRATION.md:
 * userIdentifier() and userAttributes() now return the correct values.
 * v1 assigned them backwards at grovs_manager.js:66-67.
 */
export class GrovsV1 {
  private readonly client: GrovsClient;
  private readonly links: LinkGenerator;
  private readonly messages: MessagesService;
  private ui: MessagesUI | null = null;

  constructor(
    apiKey: string,
    testEnvironment: boolean,
    private readonly linkHandlingCallback: (data: Record<string, unknown>) => void,
    deps: ClientDeps = {},
  ) {
    this.client = new GrovsClient(
      {
        apiKey,
        testEnvironment,
        onDeeplink: (payload) => this.linkHandlingCallback(payload),
      },
      deps,
    );
    this.links = new LinkGenerator(this.client);
    this.messages = new MessagesService(this.client);
    // So a reset — this tab's or another's — closes the list this shim owns.
    this.client.messagesUI = () => this.messagesUI();
    v1Constructed = true;
    warnCoexistence();
  }

  async start(successfullyAuthenticatedCallback?: () => void): Promise<void> {
    deprecate('start', 'Grovs.configure()');
    const ok = await this.client.configure();
    if (ok) successfullyAuthenticatedCallback?.();
  }

  async createLink(
    title: string,
    subtitle: string,
    imageURL: string,
    data: Record<string, unknown>,
    success: SuccessCallback<string>,
    error: ErrorCallback,
  ): Promise<void> {
    deprecate('createLink', 'Grovs.generateLink()');
    const link = await this.links.generateLink({ title, subtitle, imageURL, data });
    if (link) success(link);
    else error('Grovs — could not generate the link. See the SDK error callback for detail.');
  }

  userIdentifier(): string | null {
    deprecate('userIdentifier', 'Grovs.userIdentifier');
    return this.client.userIdentifier;
  }

  userAttributes(): Record<string, unknown> | null {
    deprecate('userAttributes', 'Grovs.userAttributes');
    return this.client.userAttributes;
  }

  setUserIdentifier(identifier: string): void {
    deprecate('setUserIdentifier', 'Grovs.setUserIdentifier()');
    this.client.setUserIdentifier(identifier);
  }

  setUserAttributes(attributes: Record<string, unknown>): void {
    deprecate('setUserAttributes', 'Grovs.setUserAttributes()');
    this.client.setUserAttributes(attributes);
  }

  authenticated(): boolean {
    deprecate('authenticated', 'Grovs.isAuthenticated()');
    return this.client.isAuthenticated();
  }

  showMessagesList(): void {
    deprecate('showMessagesList', 'Grovs.showMessagesList()');
    void this.messagesUI()?.showMessagesList();
  }

  /**
   * v1 called `error` on a failed fetch. The v2 service returns [] for both
   * "no messages" and "request failed", so the two are told apart here —
   * calling `response([])` on a network error would silently break an
   * integrator's retry logic or error UI.
   */
  async getMessages(
    page: number,
    response: SuccessCallback<GrovsMessage[]>,
    error: ErrorCallback,
  ): Promise<void> {
    deprecate('getMessages', 'Grovs.getMessages()');
    const result = await this.messages.fetchMessages(page);
    if (result === null) {
      error('Grovs — could not fetch messages.');
      return;
    }
    response(result);
  }

  async getNumberOfUnreadMessages(
    response: SuccessCallback<number>,
    error: ErrorCallback,
  ): Promise<void> {
    deprecate('getNumberOfUnreadMessages', 'Grovs.numberOfUnreadMessages()');
    const result = await this.messages.fetchUnreadCount();
    if (result === null) {
      error('Grovs — could not fetch the unread message count.');
      return;
    }
    response(result);
  }

  getAllReceivedData(): Record<string, unknown>[] {
    deprecate('getAllReceivedData', 'Grovs.allReceivedPayloadsSinceStartup()');
    return this.client.allReceivedPayloadsSinceStartup();
  }

  async markMessageAsRead(
    message: GrovsMessage,
    response: SuccessCallback<boolean>,
    error: ErrorCallback,
  ): Promise<void> {
    deprecate('markMessageAsRead', 'Grovs.markMessageAsRead()');
    const ok = await this.messages.markMessageAsRead(message.id);
    if (ok) response(true);
    else error('Grovs — could not mark the message as read.');
  }

  private messagesUI(): MessagesUI | null {
    const doc = getDocument();
    if (!doc) return null;
    this.ui ??= new MessagesUI(doc, this.messages, new Logger());
    return this.ui;
  }
}
