import type { GrovsClient } from '../core/client';
import { GrovsError } from '../net/errors';

export interface GrovsMessage {
  id: number;
  title: string;
  subtitle: string;
  read: boolean;
  access_url: string;
}

export class MessagesService {
  constructor(private readonly client: GrovsClient) {}

  /**
   * Every other public surface checks this; messages did not, so requests
   * went out before consent was granted, after setEnabled(false), and during
   * server rendering. Consent mode promises nothing is transmitted until
   * grantConsent() — a promise the messages endpoints were quietly breaking.
   */
  private get usable(): boolean {
    return this.client.isActive() && this.client.isEnabled && this.client.isAuthenticated();
  }

  /**
   * Captures the lifecycle counter, so a response can be checked against the
   * identity that asked for it.
   *
   * `usable` alone is not enough: reset() makes it false, and authenticating
   * as the next visitor makes it true again — so a request started for visitor
   * A could be validated by visitor B's authentication and rendered into B's
   * list.
   */
  private inFlightGuard(): () => boolean {
    const generation = this.client.lifecycleGeneration;
    return () => this.usable && this.client.lifecycleGeneration === generation;
  }

  /** Distinguishes "no messages" from "request failed", which the array
   *  return cannot. The v1 shim needs the difference for its error callback. */
  async fetchMessages(page: number): Promise<GrovsMessage[] | null> {
    if (!this.usable) return null;
    const valid = this.inFlightGuard();
    const response = await this.client.service.messagesForDevice(page);
    // Re-check after the await: a response that arrives after setEnabled(false)
    // or reset() must not reach the UI, and one that arrives after a *new*
    // visitor authenticated must not reach theirs.
    if (!valid()) return null;
    if (!response.ok) {
      this.client.log.reportError(
        GrovsError.networkRequestFailed,
        `Could not fetch messages (page ${page}).`,
      );
      return null;
    }
    return this.readNotifications(response.body);
  }

  async fetchUnreadCount(): Promise<number | null> {
    if (!this.usable) return null;
    const valid = this.inFlightGuard();
    const response = await this.client.service.numberOfUnreadMessages();
    if (!valid()) return null;
    if (!response.ok) {
      this.client.log.reportError(
        GrovsError.networkRequestFailed,
        'Could not fetch the unread message count.',
      );
      return null;
    }
    const value = (response.body as Record<string, unknown> | null)?.[
      'number_of_unread_notifications'
    ];
    return typeof value === 'number' ? value : 0;
  }

  /** Collapses "failed" and "none" into the array shape the v2 API promises. */
  async getMessages(page: number): Promise<GrovsMessage[]> {
    return (await this.fetchMessages(page)) ?? [];
  }

  async numberOfUnreadMessages(): Promise<number> {
    return (await this.fetchUnreadCount()) ?? 0;
  }

  async markMessageAsRead(id: number): Promise<boolean> {
    if (!this.usable) return false;
    const response = await this.client.service.markMessageAsViewed(id);
    if (!response.ok) {
      this.client.log.reportError(
        GrovsError.networkRequestFailed,
        `Could not mark message ${id} as read.`,
      );
    }
    return response.ok;
  }

  /** Backs automatic display, which v1 implemented and then commented out
   *  (grovs_manager.js:229-242). iOS ships it working. */
  async messagesForAutomaticDisplay(): Promise<GrovsMessage[]> {
    if (!this.usable) return [];
    const valid = this.inFlightGuard();
    const response = await this.client.service.messagesForAutomaticDisplay();
    if (!response.ok) return [];
    // Re-check after the await: setEnabled(false) during the request would
    // otherwise still pop modals onto a page that asked the SDK to stop, and a
    // late response must not open the previous visitor's messages.
    if (!valid()) return [];
    return this.readNotifications(response.body);
  }

  private readNotifications(body: unknown): GrovsMessage[] {
    const list = (body as Record<string, unknown> | null)?.['notifications'];
    return Array.isArray(list) ? (list as GrovsMessage[]) : [];
  }
}
