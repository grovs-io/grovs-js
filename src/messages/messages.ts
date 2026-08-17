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
    return this.client.isEnabled && this.client.isAuthenticated();
  }

  /** Distinguishes "no messages" from "request failed", which the array
   *  return cannot. The v1 shim needs the difference for its error callback. */
  async fetchMessages(page: number): Promise<GrovsMessage[] | null> {
    if (!this.usable) return null;
    const response = await this.client.service.messagesForDevice(page);
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
    const response = await this.client.service.numberOfUnreadMessages();
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

  async getMessages(page: number): Promise<GrovsMessage[]> {
    if (!this.usable) return [];
    const response = await this.client.service.messagesForDevice(page);
    if (!response.ok) {
      this.client.log.reportError(
        GrovsError.networkRequestFailed,
        `Could not fetch messages (page ${page}).`,
      );
      return [];
    }
    return this.readNotifications(response.body);
  }

  async numberOfUnreadMessages(): Promise<number> {
    if (!this.usable) return 0;
    const response = await this.client.service.numberOfUnreadMessages();
    if (!response.ok) {
      this.client.log.reportError(
        GrovsError.networkRequestFailed,
        'Could not fetch the unread message count.',
      );
      return 0;
    }
    const value = (response.body as Record<string, unknown> | null)?.[
      'number_of_unread_notifications'
    ];
    return typeof value === 'number' ? value : 0;
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
    const response = await this.client.service.messagesForAutomaticDisplay();
    if (!response.ok) return [];
    return this.readNotifications(response.body);
  }

  private readNotifications(body: unknown): GrovsMessage[] {
    const list = (body as Record<string, unknown> | null)?.['notifications'];
    return Array.isArray(list) ? (list as GrovsMessage[]) : [];
  }
}
