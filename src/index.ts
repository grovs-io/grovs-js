import { GrovsClient } from './core/client';
import type { GrovsConfig } from './core/config';
import { LinkGenerator } from './links/links';
import { MessagesService, type GrovsMessage } from './messages/messages';
import { MessagesUI } from './messages/messages-ui';
import { getDocument } from './core/environment';
import { Logger, type LogLevel } from './logging/logger';
import type { CreateLinkParams } from './net/api';
import { GrovsV1 } from './compat/v1';

let client: GrovsClient | null = null;
let links: LinkGenerator | null = null;
let messages: MessagesService | null = null;
let ui: MessagesUI | null = null;

const fallbackLogger = new Logger();

function notConfigured(method: string): void {
  fallbackLogger.warn(`${method}() called before configure(); the call is a no-op.`);
}

function messagesUI(): MessagesUI | null {
  const doc = getDocument();
  if (!doc || !messages || !client) return null;
  ui ??= new MessagesUI(doc, messages, client.log);
  return ui;
}

/**
 * The v2 facade. Mirrors the static shape of the iOS Grovs class so the two
 * SDKs read as one product.
 */
export const Grovs = {
  async configure(config: GrovsConfig): Promise<boolean> {
    client = new GrovsClient(config);
    links = new LinkGenerator(client);
    messages = new MessagesService(client);
    ui = null;
    return client.configure();
  },

  generateLink(params: CreateLinkParams): Promise<string | null> {
    if (!links) {
      notConfigured('generateLink');
      return Promise.resolve(null);
    }
    return links.generateLink(params);
  },

  get userIdentifier(): string | null {
    return client?.userIdentifier ?? null;
  },

  get userAttributes(): Record<string, unknown> | null {
    return client?.userAttributes ?? null;
  },

  setUserIdentifier(identifier: string | null): void {
    if (!client) return notConfigured('setUserIdentifier');
    client.setUserIdentifier(identifier);
  },

  setUserAttributes(attributes: Record<string, unknown> | null): void {
    if (!client) return notConfigured('setUserAttributes');
    client.setUserAttributes(attributes);
  },

  isAuthenticated(): boolean {
    return client?.isAuthenticated() ?? false;
  },

  setEnabled(enabled: boolean): void {
    if (!client) return notConfigured('setEnabled');
    client.setEnabled(enabled);
  },

  setDebugLevel(level: LogLevel): void {
    if (!client) {
      fallbackLogger.setLevel(level);
      return;
    }
    client.setDebugLevel(level);
  },

  allReceivedPayloadsSinceStartup(): Record<string, unknown>[] {
    return client?.allReceivedPayloadsSinceStartup() ?? [];
  },

  lastReceivedPayload(): Record<string, unknown> | null {
    return client?.lastReceivedPayload() ?? null;
  },

  showMessagesList(): Promise<void> {
    const surface = messagesUI();
    if (!surface) {
      notConfigured('showMessagesList');
      return Promise.resolve();
    }
    return surface.showMessagesList();
  },

  getMessages(page: number): Promise<GrovsMessage[]> {
    if (!messages) {
      notConfigured('getMessages');
      return Promise.resolve([]);
    }
    return messages.getMessages(page);
  },

  numberOfUnreadMessages(): Promise<number> {
    if (!messages) {
      notConfigured('numberOfUnreadMessages');
      return Promise.resolve(0);
    }
    return messages.numberOfUnreadMessages();
  },

  markMessageAsRead(id: number): Promise<boolean> {
    if (!messages) {
      notConfigured('markMessageAsRead');
      return Promise.resolve(false);
    }
    return messages.markMessageAsRead(id);
  },

  /** The deprecated v1 class. `new Grovs.V1(key, testEnv, callback)`. */
  V1: GrovsV1,
};

export { GrovsError } from './net/errors';
export { SDK_VERSION } from './version';
export type { GrovsConfig, DeeplinkCallback } from './core/config';
export type { LogLevel, ErrorCallback } from './logging/logger';
export type { GrovsMessage } from './messages/messages';
export type { CreateLinkParams } from './net/api';
export { GrovsV1 };

export default Grovs;
