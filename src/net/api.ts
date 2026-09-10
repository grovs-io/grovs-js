import type { ResolvedConfig } from '../core/config';
import type { Context } from '../core/context';
import { buildHeaders } from './headers';
import type { Transport, TransportResponse } from './transport';

export interface DeviceDetails {
  user_agent: string;
  app_version: string;
  build: string;
  /** The browser fingerprint the backend matches deferred deep links against
   *  (spec B5). Every field is optional: a browser that blocks WebGL should
   *  degrade the match, not fail the request. */
  screen_width?: number;
  screen_height?: number;
  timezone?: string;
  webgl_vendor?: string;
  webgl_renderer?: string;
  language?: string;
  /** Threaded into SdkLinkDataService on the link endpoints (spec B10). */
  session_id?: string;
}

/** Per-platform redirect overrides, mirroring CustomRedirects on iOS. */
export interface CustomRedirects {
  ios?: { link?: string; openAppIfInstalled?: boolean };
  android?: { link?: string; openAppIfInstalled?: boolean };
  desktop?: { link?: string };
}

export interface CreateLinkParams {
  title?: string;
  subtitle?: string;
  imageURL?: string;
  data?: Record<string, unknown>;
  tags?: string[];
  customRedirects?: CustomRedirects;
  showPreviewiOS?: boolean;
  showPreviewAndroid?: boolean;
  /** Copies the link on the preview page so a fresh install can be matched to
   *  it. Omit to inherit the project default; needs `showPreviewiOS`. */
  copyToClipboardiOS?: boolean;
  /** Android counterpart; needs `showPreviewAndroid`. */
  copyToClipboardAndroid?: boolean;
  /** Campaign name, e.g. "BlackFriday2025". */
  trackingCampaign?: string;
  /** Traffic source, e.g. "instagram", "newsletter". */
  trackingSource?: string;
  /** Medium, e.g. "cpc", "email", "social". */
  trackingMedium?: string;
}

/**
 * The batch endpoint answers HTTP 200 with per-event results (spec B6).
 * A 200 does not mean every event landed.
 */
export interface BatchResult {
  accepted: number;
  rejected: number;
  errors: { index: number; error: string }[];
}

/** Paths mirror Constants.URLs in the iOS APIService. */
const PATHS = {
  authenticate: '/authenticate',
  batchEvents: '/events/batch',
  screenAliases: '/screen_aliases',
  linkDetails: '/link_details',
  addPaymentEvent: '/add_payment_event',
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
    /**
     * Builds a fresh abandon predicate per request, so it can close over the
     * lifecycle as it was when the request left — see TransportRequest.abandon.
     */
    private readonly abandonRetries: () => () => boolean = () => () => false,
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

  /** The full parameter surface, matching Grovs.generateLink on iOS. */
  createLink(params: CreateLinkParams): Promise<TransportResponse> {
    const body: Record<string, unknown> = {};
    if (params.title) body['title'] = params.title;
    if (params.subtitle) body['subtitle'] = params.subtitle;
    if (params.imageURL) body['image_url'] = params.imageURL;
    // The backend permits :data and :tags as scalar params, so both arrive
    // as JSON strings rather than as structures.
    if (params.data) body['data'] = JSON.stringify(params.data);
    if (params.tags && params.tags.length > 0) body['tags'] = JSON.stringify(params.tags);
    if (params.customRedirects) {
      Object.assign(body, serializeRedirects(params.customRedirects));
    }
    if (typeof params.showPreviewiOS === 'boolean') body['show_preview_ios'] = params.showPreviewiOS;
    if (typeof params.showPreviewAndroid === 'boolean') {
      body['show_preview_android'] = params.showPreviewAndroid;
    }
    // Absent means "inherit the project default" server-side (the column is
    // tri-state), so an unset option must leave the key out, not send false.
    // Defined outside this repo, in the backend's clipboard design note.
    if (typeof params.copyToClipboardiOS === 'boolean') {
      body['copy_to_clipboard_ios'] = params.copyToClipboardiOS;
    }
    if (typeof params.copyToClipboardAndroid === 'boolean') {
      body['copy_to_clipboard_android'] = params.copyToClipboardAndroid;
    }
    if (params.trackingCampaign) body['tracking_campaign'] = params.trackingCampaign;
    if (params.trackingSource) body['tracking_source'] = params.trackingSource;
    if (params.trackingMedium) body['tracking_medium'] = params.trackingMedium;
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

  /** Caps at 50 server-side; the caller chunks. `keepalive` is set for the
   *  pagehide flush, where a normal request would be cancelled on unload. */
  addEvents(events: unknown[], keepalive = false): Promise<TransportResponse> {
    return this.transport.send({
      method: 'POST',
      url: this.config.endpoint + PATHS.batchEvents,
      headers: this.headers(),
      body: { events },
      abandon: this.abandonRetries(),
      ...(keepalive ? { keepalive: true } : {}),
    });
  }

  /** Backend caps at 200 per request (spec B8); the caller chunks. */
  syncScreenAliases(aliases: { identifier: string; alias: string }[]): Promise<TransportResponse> {
    return this.post(PATHS.screenAliases, { screen_aliases: aliases });
  }

  linkDetails(path: string): Promise<TransportResponse> {
    return this.post(PATHS.linkDetails, { path });
  }

  /** Enterprise deployments only — the route does not exist unless
   *  GROVS_EE=true, so a 404 here is a configuration answer (spec B4). */
  addPaymentEvent(body: unknown): Promise<TransportResponse> {
    return this.post(PATHS.addPaymentEvent, body);
  }

  private post(path: string, body: unknown): Promise<TransportResponse> {
    return this.transport.send({
      method: 'POST',
      url: this.config.endpoint + path,
      headers: this.headers(),
      body,
      abandon: this.abandonRetries(),
    });
  }

  private get(path: string): Promise<TransportResponse> {
    return this.transport.send({
      method: 'GET',
      url: this.config.endpoint + path,
      headers: this.headers(),
      abandon: this.abandonRetries(),
    });
  }

  private headers(): Record<string, string> {
    return buildHeaders(this.config, this.context, this.identifierProvider());
  }
}

/**
 * One JSON-string param per platform — ios_custom_redirect /
 * android_custom_redirect / desktop_custom_redirect, each {url,
 * open_app_if_installed} — matching iOS's APIService and the backend's
 * CustomRedirectsHandler, which reads exactly those keys and (for phone
 * platforms) rejects an entry missing open_app_if_installed.
 */
function serializeRedirects(redirects: CustomRedirects): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const platform of ['ios', 'android', 'desktop'] as const) {
    const entry = redirects[platform];
    if (!entry || typeof entry !== 'object' || typeof entry.link !== 'string' || !entry.link) {
      continue;
    }
    const serialized: Record<string, unknown> = { url: entry.link };
    if (platform !== 'desktop') {
      serialized['open_app_if_installed'] =
        'openAppIfInstalled' in entry && typeof entry.openAppIfInstalled === 'boolean'
          ? entry.openAppIfInstalled
          : false;
    }
    out[`${platform}_custom_redirect`] = JSON.stringify(serialized);
  }
  return out;
}
