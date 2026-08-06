import type { ResolvedConfig } from '../core/config';
import type { Context } from '../core/context';
import { buildHeaders } from './headers';
import type { Transport, TransportResponse } from './transport';

export interface DeviceDetails {
  user_agent: string;
  app_version: string;
  build: string;
}

export interface CreateLinkParams {
  title?: string;
  subtitle?: string;
  imageURL?: string;
  data?: Record<string, unknown>;
}

/** Paths mirror Constants.URLs in the iOS APIService. */
const PATHS = {
  authenticate: '/authenticate',
  dataForDevice: '/data_for_device',
  dataForDeviceAndPath: '/data_for_device_and_path',
  createLink: '/create_link',
  attributes: '/visitor_attributes',
  notifications: '/notifications_for_device',
  markNotificationAsRead: '/mark_notification_as_read',
  notificationsToDisplayAutomatically: '/notifications_to_display_automatically',
  numberOfUnreadNotifications: '/number_of_unread_notifications',
} as const;

export class ApiService {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly context: Context,
    private readonly transport: Transport,
    private readonly identifierProvider: () => string | null,
  ) {}

  authenticate(details: DeviceDetails): Promise<TransportResponse> {
    return this.post(PATHS.authenticate, details);
  }

  payloadForDevice(details: DeviceDetails): Promise<TransportResponse> {
    return this.post(PATHS.dataForDevice, details);
  }

  /**
   * Spec B1: the path variant is a project-scoped lookup
   * (LinksService.link_for_project_and_path), which is what the web SDK
   * extracts from the URL. The _and_url variant carries a
   * competitor-migration fallback shaped for mobile.
   */
  payloadForDeviceAndPath(details: DeviceDetails, path: string): Promise<TransportResponse> {
    return this.post(PATHS.dataForDeviceAndPath, { ...details, path });
  }

  createLink(params: CreateLinkParams): Promise<TransportResponse> {
    const body: Record<string, unknown> = {};
    if (params.title) body['title'] = params.title;
    if (params.subtitle) body['subtitle'] = params.subtitle;
    if (params.imageURL) body['image_url'] = params.imageURL;
    // The backend permits :data as a scalar param, so it arrives as a string.
    if (params.data) body['data'] = JSON.stringify(params.data);
    return this.post(PATHS.createLink, body);
  }

  setUserAttributes(): Promise<TransportResponse> {
    const body: Record<string, unknown> = {
      sdk_identifier: this.context.userIdentifier,
    };
    if (this.context.userAttributes) {
      body['sdk_attributes'] = this.context.userAttributes;
    }
    return this.post(PATHS.attributes, body);
  }

  messagesForDevice(page: number): Promise<TransportResponse> {
    return this.post(PATHS.notifications, { page });
  }

  markMessageAsViewed(id: number): Promise<TransportResponse> {
    return this.post(PATHS.markNotificationAsRead, { id });
  }

  messagesForAutomaticDisplay(): Promise<TransportResponse> {
    return this.get(PATHS.notificationsToDisplayAutomatically);
  }

  numberOfUnreadMessages(): Promise<TransportResponse> {
    return this.get(PATHS.numberOfUnreadNotifications);
  }

  private post(path: string, body: unknown): Promise<TransportResponse> {
    return this.transport.send({
      method: 'POST',
      url: this.config.endpoint + path,
      headers: this.headers(),
      body,
    });
  }

  private get(path: string): Promise<TransportResponse> {
    return this.transport.send({
      method: 'GET',
      url: this.config.endpoint + path,
      headers: this.headers(),
    });
  }

  private headers(): Record<string, string> {
    return buildHeaders(this.config, this.context, this.identifierProvider());
  }
}
