import { GrovsClient } from './core/client';
import { resolveConfig, type GrovsConfig } from './core/config';
import { LinkGenerator } from './links/links';
import { getWindow } from './core/environment';
import { Logger, type LogLevel } from './logging/logger';
import type { CreateLinkParams } from './net/api';
import { GrovsV1, noteFacadeConfigured, type GrovsMessage } from './compat/v1';
import type { ScreenNameProvider } from './tracking/auto-screen-tracker';
import type { CustomPurchase } from './events/payment-events-handler';
import type { InAppCallbacks } from './inapp/controller';
import type { SmartBannerLinkData } from './smartBanner/link-data';
import { currentRoute } from './smartBanner/match';

let client: GrovsClient | null = null;
let links: LinkGenerator | null = null;

/**
 * In-app settings outlive a client: configure() builds a new one, and a host
 * that paused messages or excluded its checkout screen before that must not
 * find them showing afterwards.
 */
const inAppSettings: { callbacks: InAppCallbacks; excluded: string[]; paused: boolean; debug: boolean } = {
  callbacks: {},
  excluded: [],
  paused: false,
  debug: false,
};

function applyInAppSettings(target: GrovsClient): void {
  Object.assign(target.inApp.callbacks, inAppSettings.callbacks);
  target.inApp.setExcludedScreens(inAppSettings.excluded);
  target.inApp.debug = inAppSettings.debug;
  if (inAppSettings.paused) target.inApp.pause();
}

const fallbackLogger = new Logger();

// The page's latest setLinkData/hide, replayed into a client configured later on the same route.
let bannerCalls: { path: string; data?: SmartBannerLinkData; hidden?: boolean } | null = null;

function bannerRoute(): string {
  const win = getWindow();
  return win ? currentRoute(win.location) : '';
}

function bannerPage(): NonNullable<typeof bannerCalls> {
  const path = bannerRoute();
  if (bannerCalls?.path !== path) bannerCalls = { path };
  return bannerCalls;
}

function notConfigured(method: string): void {
  fallbackLogger.warn(`${method}() called before configure(); the call is a no-op.`);
}

/**
 * The v2 facade. Mirrors the static shape of the iOS Grovs class so the two
 * SDKs read as one product.
 */
const facade = {
  async configure(config: GrovsConfig): Promise<boolean> {
    noteFacadeConfigured();
    // Validate before retiring: a throw must not strand the facade on a dead
    // client. Construct after, or the new queue loads before the old one persists.
    resolveConfig(config);

    // React strict mode and hot reload call this twice. The per-client guard
    // cannot help here: a second call builds a *new* client, so without this
    // the previous one's flush interval, lifecycle listeners and History
    // patch stay live and everything is tracked twice.
    client?.dispose();

    const next = new GrovsClient(config);
    client = next;
    links = new LinkGenerator(next);
    applyInAppSettings(next);
    // An identity reset — local, cross-tab, or a delayed cross-tab one — must drop
    // whatever this page remembered calling, or it replays onto the next visitor.
    next.onReset = () => {
      bannerCalls = null;
    };
    if (bannerCalls?.path === bannerRoute()) {
      if (bannerCalls.data) next.smartBanner.setLinkData(bannerCalls.data);
      if (bannerCalls.hidden) next.smartBanner.hide();
    }
    return next.configure();
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

  // MARK: Analytics

  track(name: string, properties?: Record<string, unknown>, tags?: string[]): void {
    if (!client) return notConfigured('track');
    client.track(name, properties, tags);
  },

  trackScreenView(screenName: string, properties?: Record<string, unknown>): void {
    if (!client) return notConfigured('trackScreenView');
    client.trackScreenView(screenName, properties);
  },

  setGlobalTags(tags: string[] | null): void {
    if (!client) return notConfigured('setGlobalTags');
    client.setGlobalTags(tags);
  },

  setScreenAliases(aliases: Record<string, string>): void {
    if (!client) return notConfigured('setScreenAliases');
    client.setScreenAliases(aliases);
  },

  set screenNameProvider(provider: ScreenNameProvider | null) {
    if (!client) {
      notConfigured('screenNameProvider');
      return;
    }
    client.screenNameProvider = provider;
  },

  get screenNameProvider(): ScreenNameProvider | null {
    return client?.screenNameProvider ?? null;
  },

  /**
   * Fetches details for a link generated by the SDK in this environment.
   * Resolves null when the path is unknown.
   */
  linkDetails(path: string): Promise<Record<string, unknown> | null> {
    if (!links) {
      notConfigured('linkDetails');
      return Promise.resolve(null);
    }
    return links.linkDetails(path);
  },

  /**
   * Logs a purchase. Requires a Grovs Enterprise backend (GROVS_EE=true);
   * on a standard deployment this reports eventDispatchFailed naming the
   * requirement rather than retrying.
   */
  logCustomPurchase(purchase: CustomPurchase): Promise<boolean> {
    if (!client) {
      notConfigured('logCustomPurchase');
      return Promise.resolve(false);
    }
    return client.logCustomPurchase(purchase);
  },

  /** @deprecated The messages inbox was removed; in-app messages replace it. Does nothing. */
  displayAutomaticMessages(): Promise<void> {
    return Promise.resolve();
  },

  /**
   * Grants consent when configure() was called with requireConsent: true.
   * Migrates anything tracked meanwhile into durable storage and authenticates.
   */
  grantConsent(): Promise<boolean> {
    if (!client) {
      notConfigured('grantConsent');
      return Promise.resolve(false);
    }
    return client.grantConsent();
  },

  /** Clears stored identifiers, the session and the queued events. */
  reset(): void {
    if (!client) return notConfigured('reset');
    client.reset(); // onReset clears bannerCalls
  },

  /** Drains the queue now, for integrators facing a hard navigation. */
  flush(): Promise<void> {
    if (!client) {
      notConfigured('flush');
      return Promise.resolve();
    }
    return client.flush();
  },

  allReceivedPayloadsSinceStartup(): Record<string, unknown>[] {
    return client?.allReceivedPayloadsSinceStartup() ?? [];
  },

  lastReceivedPayload(): Record<string, unknown> | null {
    return client?.lastReceivedPayload() ?? null;
  },

  /** The dashboard-configured mobile banner. setLinkData and hide made before configure() apply once it runs. */
  smartBanner: {
    setLinkData(data: SmartBannerLinkData): void {
      bannerPage().data = data;
      client?.smartBanner.setLinkData(data);
    },
    hide(): void {
      bannerPage().hidden = true;
      client?.smartBanner.hide();
    },
    refresh(): Promise<void> {
      if (!client) {
        notConfigured('smartBanner.refresh');
        return Promise.resolve();
      }
      return client.smartBanner.refresh(); // never rejects
    },
  },

  /** @deprecated The messages inbox was removed; in-app messages replace it. Does nothing. */
  showMessagesList(): Promise<void> {
    return Promise.resolve();
  },

  /** @deprecated The messages inbox was removed; in-app messages replace it. Always resolves []. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getMessages(page: number): Promise<GrovsMessage[]> {
    return Promise.resolve([]);
  },

  /** @deprecated The messages inbox was removed; in-app messages replace it. Always resolves 0. */
  numberOfUnreadMessages(): Promise<number> {
    return Promise.resolve(0);
  },

  /** @deprecated The messages inbox was removed; in-app messages replace it. Always resolves true. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  markMessageAsRead(id: number): Promise<boolean> {
    return Promise.resolve(true);
  },

  /**
   * In-app messages. Campaigns are created in the dashboard and shown by the
   * SDK when their trigger fires; nothing here is needed for that to work.
   * These calls let the host page hold messages back and react to them.
   */
  inApp: {
    /** Holds messages back, for a checkout or a video. The newest highest priority one waits. */
    pause(): void {
      inAppSettings.paused = true;
      client?.inApp.pause();
    },

    /** Lets messages show again, starting with the one that waited, if it still qualifies. */
    resume(): void {
      inAppSettings.paused = false;
      client?.inApp.resume();
    },

    /** Drops the waiting message and stays paused; pass true to also close the one on screen. */
    discard(dismiss = false): void {
      inAppSettings.paused = true;
      client?.inApp.discard(dismiss);
    },

    /** Screens, by the name given to trackScreenView, on which no message shows. Messages wait. */
    setExcludedScreens(names: string[]): void {
      inAppSettings.excluded = Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [];
      client?.inApp.setExcludedScreens(inAppSettings.excluded);
    },

    /** beforeShow can stop a message by returning false; the others report what happened. */
    setCallbacks(callbacks: InAppCallbacks): void {
      inAppSettings.callbacks = { ...callbacks };
      if (!client) return;
      for (const key of Object.keys(client.inApp.callbacks)) delete client.inApp.callbacks[key as keyof InAppCallbacks];
      Object.assign(client.inApp.callbacks, inAppSettings.callbacks);
    },

    /** Logs, at info level, each campaign considered for an event and why it was skipped. */
    setDebug(enabled: boolean): void {
      inAppSettings.debug = enabled === true;
      if (client) client.inApp.debug = inAppSettings.debug;
    },
  },

  /** The deprecated v1 class. `new Grovs.V1(key, testEnv, callback)`. */
  V1: GrovsV1,
};

/**
 * v1 integrators construct the SDK — `new Grovs(key, testEnv, cb)` from npm,
 * `new Grovs.default(...)` from the CDN bundle — so the export itself must be
 * constructable, not a plain object. Construction hands back the deprecated
 * v1 surface; the v2 facade rides on the same value as statics.
 *
 * defineProperties rather than Object.assign: the facade has accessors
 * (userIdentifier, screenNameProvider), and assign would read them once and
 * copy the values.
 */
class GrovsExport extends GrovsV1 {}
Object.defineProperties(GrovsExport, Object.getOwnPropertyDescriptors(facade));

export const Grovs = GrovsExport as typeof GrovsExport & typeof facade;

import { GrovsError } from './net/errors';
import { SDK_VERSION } from './version';

export { GrovsError };
export { SDK_VERSION };
export type { GrovsConfig, DeeplinkCallback } from './core/config';
export type { LogLevel, ErrorCallback } from './logging/logger';
export type { GrovsMessage } from './compat/v1';
export type { MessagesTheme } from './core/config';
export type { CreateLinkParams } from './net/api';
export type { ScreenNameProvider, ScreenNameDecision } from './tracking/auto-screen-tracker';
export type { CustomRedirects } from './net/api';
export type { CustomPurchase, TransactionType } from './events/payment-events-handler';
export type { InAppCallbacks } from './inapp/controller';
export type { SmartBannerLinkData } from './smartBanner/link-data';
export { GrovsV1 };

export default Grovs;
