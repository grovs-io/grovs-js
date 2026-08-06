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

  async getMessages(page: number): Promise<GrovsMessage[]> {
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
    const response = await this.client.service.messagesForAutomaticDisplay();
    if (!response.ok) return [];
    return this.readNotifications(response.body);
  }

  private readNotifications(body: unknown): GrovsMessage[] {
    const list = (body as Record<string, unknown> | null)?.['notifications'];
    return Array.isArray(list) ? (list as GrovsMessage[]) : [];
  }
}
