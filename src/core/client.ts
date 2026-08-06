import { Logger, type LogLevel } from '../logging/logger';
import { GrovsError } from '../net/errors';
import { ApiService, type DeviceDetails } from '../net/api';
import { FetchTransport } from '../net/fetch-transport';
import type { Transport } from '../net/transport';
import { DeeplinkResolver } from '../links/deeplink';
import { resolveStorage, type Storage } from '../storage/storage';
import { IdentityStore } from '../storage/identity';
import { PersistedQueue } from '../storage/persisted-queue';
import { EventsHandler } from '../events/events-handler';
import { CustomEventsHandler } from '../events/custom-events-handler';
import { LifecycleTracker } from '../tracking/lifecycle';
import { AutoScreenTracker, type ScreenNameProvider } from '../tracking/auto-screen-tracker';
import { ScreenAliases } from '../tracking/screen-aliases';
import { SessionManager } from './session';
import { SystemClock, type Clock } from './clock';
import {
  getFingerprint,
  getNavigator,
  getPageIdentifier,
  getWindow,
  isBrowser,
} from './environment';
import { resolveConfig, type GrovsConfig, type ResolvedConfig } from './config';
import { Context } from './context';

export const LINKSQUARED_STORAGE_KEY = 'linksquared';
const OPENS_KEY = 'grovs_opens';
const LAST_START_KEY = 'grovs_last_start';

export interface ClientDeps {
  transport?: Transport;
  storage?: Storage;
  clock?: Clock;
  /** Suppresses timers and lifecycle listeners in tests that do not need them. */
  autoStartEvents?: boolean;
}

export class GrovsClient {
  private readonly config: ResolvedConfig;
  private readonly logger = new Logger();
  private readonly context = new Context();
  private readonly storage: Storage;
  private readonly api: ApiService;
  private readonly deeplinks: DeeplinkResolver;
  private readonly identity: IdentityStore | null;
  private readonly clock: Clock;
  private readonly session: SessionManager;
  private readonly queue: PersistedQueue;
  private readonly events: EventsHandler;
  private readonly custom: CustomEventsHandler;
  private readonly lifecycle: LifecycleTracker;
  private readonly aliases = new ScreenAliases();
  private readonly screens: AutoScreenTracker;
  private readonly autoStartEvents: boolean;

  private enabled = true;
  private readonly receivedPayloads: Record<string, unknown>[] = [];
  /** True when identity was set before authentication finished, so it still
   *  needs pushing. Mirrors shouldUpdateIdentifiers in v1's manager. */
  private identityDirty = false;

  constructor(config: GrovsConfig, deps: ClientDeps = {}) {
    this.config = resolveConfig(config);
    this.logger.setLevel(this.config.debugLevel);
    this.logger.setOnError(this.config.onError);

    this.clock = deps.clock ?? new SystemClock();
    this.autoStartEvents = deps.autoStartEvents ?? true;

    this.storage = deps.storage ?? resolveStorage(this.logger, this.config.cookieDomain);
    // An injected storage means a test harness; the mirrored identity store
    // reaches for real browser globals, so it is only built for real use.
    this.identity = deps.storage ? null : new IdentityStore(this.config.cookieDomain);

    this.api = new ApiService(
      this.config,
      this.context,
      deps.transport ?? new FetchTransport(),
      () => getPageIdentifier(),
    );
    this.deeplinks = new DeeplinkResolver(this.storage, () => getWindow()?.location.href ?? null);

    this.session = new SessionManager(this.storage, this.clock);
    this.queue = new PersistedQueue(this.storage, this.clock, (count, reason) =>
      this.logger.warn(`Dropped ${count} queued event(s): ${reason}.`),
    );
    this.events = new EventsHandler({
      api: this.api,
      queue: this.queue,
      session: this.session,
      clock: this.clock,
      logger: this.logger,
      currentPath: () => this.deeplinks.getStoredPath(),
      isEnabled: () => this.enabled,
    });
    this.custom = new CustomEventsHandler({
      events: this.events,
      session: this.session,
      clock: this.clock,
      logger: this.logger,
      currentPath: () => this.deeplinks.getStoredPath(),
    });
    this.lifecycle = new LifecycleTracker({
      clock: this.clock,
      onEngagement: (seconds) => this.events.log('time_spent', seconds),
      onExit: () => this.events.flushOnExit(),
    });
    this.screens = new AutoScreenTracker({
      aliases: this.aliases,
      onScreen: (name) => this.custom.trackScreenView(name),
    });

    this.context.linksquaredId = this.readIdentity();
  }

  async configure(): Promise<boolean> {
    if (!isBrowser()) {
      // Spec A1: the no-op is loud. A server-side call could never have
      // succeeded — IDENTIFIER comes from window.location and B9 rejects a
      // request without it — and a silent success is the exact defect A5
      // exists to remove.
      this.logger.reportErrorOnce(
        'configure',
        GrovsError.networkRequestFailed,
        'configure() was called outside a browser. The SDK is inert during server rendering; ' +
          'call it again on the client.',
      );
      return false;
    }

    this.deeplinks.capture();

    const response = await this.api.authenticate(this.deviceDetails());
    if (!response.ok) {
      this.reportAuthFailure(response.status, response.body);
      return false;
    }

    const body = (response.body ?? {}) as Record<string, unknown>;
    const linksquaredId = typeof body['linksquared'] === 'string' ? body['linksquared'] : null;

    // Read before writing: whether an identifier already existed is what
    // decides install versus reinstall, and the write below destroys the answer.
    const hadIdentity = this.context.linksquaredId !== null;

    if (linksquaredId) {
      this.context.linksquaredId = linksquaredId;
      this.writeIdentity(linksquaredId);
    }

    // v1 (grovs_manager.js:66-67) assigned these two backwards. Anyone who
    // diagnosed that and read the opposite accessor on purpose is broken by
    // this fix — MIGRATION.md documents it.
    if (!this.identityDirty) {
      this.context.userIdentifier =
        typeof body['sdk_identifier'] === 'string' ? body['sdk_identifier'] : null;
      this.context.userAttributes =
        body['sdk_attributes'] && typeof body['sdk_attributes'] === 'object'
          ? (body['sdk_attributes'] as Record<string, unknown>)
          : null;
    }

    this.context.authenticated = true;
    this.logger.info('Authenticated.');

    if (this.autoStartEvents) this.startEventPipeline(hadIdentity);

    await this.fetchPayload();

    // Only now is the attribution path known, so only now may events leave.
    this.events.onPathResolved(this.deeplinks.getStoredPath());

    if (this.identityDirty) void this.pushIdentity();

    return true;
  }

  /**
   * Emits the launch events and starts the flush timers.
   *
   * The open count and last-start stamp are read before being written, because
   * both decide which launch events fire: opens === 0 means install (or
   * reinstall, if an identifier survived), and a last start more than seven
   * days ago means reactivation.
   */
  private startEventPipeline(hadIdentity: boolean): void {
    const opens = Number(this.storage.get(OPENS_KEY) ?? '0');
    const rawLastStart = this.storage.get(LAST_START_KEY);
    const lastStart = rawLastStart === null ? null : Number(rawLastStart);

    this.storage.set(OPENS_KEY, String((Number.isFinite(opens) ? opens : 0) + 1));
    this.storage.set(LAST_START_KEY, String(this.clock.now()));

    this.events.start({
      hasExistingIdentity: hadIdentity,
      opens: Number.isFinite(opens) ? opens : 1,
      lastStart: lastStart !== null && Number.isFinite(lastStart) ? lastStart : null,
    });
    this.lifecycle.start();
    if (this.config.autoTrackScreenViews) this.screens.start();
  }

  // MARK: Analytics

  track(name: string, properties?: Record<string, unknown>, tags?: string[]): void {
    if (!this.enabled) return;
    this.custom.track(name, properties, tags);
  }

  trackScreenView(screenName: string, properties?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.custom.trackScreenView(screenName, properties);
  }

  setGlobalTags(tags: string[] | null): void {
    this.custom.setGlobalTags(tags);
  }

  /** Syncs the map to the dashboard so aliases appear there too (spec B8). */
  setScreenAliases(aliases: Record<string, string>): void {
    this.aliases.set(aliases);
    if (this.context.authenticated) void this.aliases.sync(this.api, this.logger);
  }

  set screenNameProvider(provider: ScreenNameProvider | null) {
    this.screens.screenNameProvider = provider;
  }

  get screenNameProvider(): ScreenNameProvider | null {
    return this.screens.screenNameProvider;
  }

  /** Drains the queue immediately. For integrators facing a hard navigation. */
  flush(): Promise<void> {
    return this.events.flush();
  }

  /** Stops timers and detaches listeners. Used by reset() and by tests. */
  shutdown(): void {
    this.events.stop();
    this.lifecycle.stop();
    this.screens.stop();
  }

  get eventsHandler(): EventsHandler {
    return this.events;
  }

  get sessionManager(): SessionManager {
    return this.session;
  }

  private readIdentity(): string | null {
    return this.identity ? this.identity.get() : this.storage.get(LINKSQUARED_STORAGE_KEY);
  }

  private writeIdentity(value: string): void {
    if (this.identity) this.identity.set(value);
    else this.storage.set(LINKSQUARED_STORAGE_KEY, value);
  }

  get userIdentifier(): string | null {
    return this.context.userIdentifier;
  }

  get userAttributes(): Record<string, unknown> | null {
    return this.context.userAttributes;
  }

  setUserIdentifier(value: string | null): void {
    this.context.userIdentifier = value;
    this.markIdentityChanged();
  }

  setUserAttributes(value: Record<string, unknown> | null): void {
    this.context.userAttributes = value;
    this.markIdentityChanged();
  }

  isAuthenticated(): boolean {
    return this.context.authenticated;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.logger.info(`SDK ${enabled ? 'enabled' : 'disabled'}.`);
  }

  setDebugLevel(level: LogLevel): void {
    this.logger.setLevel(level);
  }

  allReceivedPayloadsSinceStartup(): Record<string, unknown>[] {
    return [...this.receivedPayloads];
  }

  lastReceivedPayload(): Record<string, unknown> | null {
    return this.receivedPayloads[this.receivedPayloads.length - 1] ?? null;
  }

  /** Exposed for links/ and messages/, which share the configured service. */
  get service(): ApiService {
    return this.api;
  }

  get log(): Logger {
    return this.logger;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private markIdentityChanged(): void {
    if (!this.enabled) return;
    if (!this.context.authenticated) {
      this.identityDirty = true;
      return;
    }
    void this.pushIdentity();
  }

  private async pushIdentity(): Promise<void> {
    const response = await this.api.setUserAttributes();
    if (response.ok) {
      this.identityDirty = false;
      return;
    }
    this.logger.reportError(
      GrovsError.networkRequestFailed,
      'Could not update the user identifier or attributes.',
    );
  }

  private async fetchPayload(): Promise<void> {
    const path = this.deeplinks.getStoredPath();
    const details = this.deviceDetails();
    const response = path
      ? await this.api.payloadForDeviceAndPath(details, path)
      : await this.api.payloadForDevice(details);

    if (!response.ok) {
      this.logger.reportError(
        GrovsError.networkRequestFailed,
        'Could not fetch the deep link payload.',
      );
      return;
    }

    const data = (response.body as Record<string, unknown> | null)?.['data'];
    if (!data || typeof data !== 'object') return;

    const payload = data as Record<string, unknown>;
    this.receivedPayloads.push(payload);
    this.config.onDeeplink?.(payload);
  }

  /**
   * Spec B5. The backend's authenticate endpoint permits eleven parameters;
   * v1 sent three, two of them the literal string "0". The screen, timezone,
   * WebGL and language fields are a browser fingerprint, and fingerprint
   * matching is exactly what `data_for_device` → `resolve_by_fingerprint`
   * uses to resolve a deferred deep link — so sending three fields left web
   * deferred deep linking matching on almost no signal.
   *
   * app_version and build stay "0": a web page has no build number, and the
   * backend treats them as free-form strings.
   */
  private deviceDetails(): DeviceDetails {
    return {
      user_agent: getNavigator()?.userAgent ?? '',
      app_version: '0',
      build: '0',
      ...getFingerprint(),
      session_id: this.session.currentSessionId(),
    };
  }

  private reportAuthFailure(status: number, body: unknown): void {
    const rawError = (body as Record<string, unknown> | null)?.['error'];
    const serverMessage = typeof rawError === 'string' ? rawError : `HTTP ${status}`;

    if (status === 422) {
      // Spec B9. WebConfigurationLinkedDomain has no normalization, so the
      // console value must match this string character for character. Printing
      // it turns "not configured" into something the integrator can act on.
      this.logger.reportError(
        GrovsError.authenticationFailed,
        `${serverMessage} The SDK sent IDENTIFIER "${getPageIdentifier() ?? '(none)'}" — ` +
          'add exactly that value to the linked domains for this project in the Grovs console.',
      );
      return;
    }

    this.logger.reportError(GrovsError.authenticationFailed, serverMessage);
  }
}
