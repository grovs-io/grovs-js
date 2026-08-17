import { Logger, type LogLevel } from '../logging/logger';
import { GrovsError } from '../net/errors';
import { ApiService, type DeviceDetails } from '../net/api';
import { FetchTransport } from '../net/fetch-transport';
import type { Transport } from '../net/transport';
import { DeeplinkResolver, STORED_PATH_KEY } from '../links/deeplink';
import type { Storage } from '../storage/storage';
import { MemoryStorage } from '../storage/memory-storage';
import { resolveBulkStorage, SwitchableStorage } from '../storage/bulk-storage';
import { IdentityStore, LINKSQUARED_STORAGE_KEY as IDENTITY_KEY } from '../storage/identity';
import { PersistedQueue, QUEUE_STORAGE_KEY } from '../storage/persisted-queue';
import { EventsHandler } from '../events/events-handler';
import { CustomEventsHandler } from '../events/custom-events-handler';
import { PaymentEventsHandler, type CustomPurchase } from '../events/payment-events-handler';
import { LifecycleTracker } from '../tracking/lifecycle';
import { AutoScreenTracker, type ScreenNameProvider } from '../tracking/auto-screen-tracker';
import { ScreenAliases } from '../tracking/screen-aliases';
import { SessionManager, SESSION_ACTIVITY_KEY, SESSION_ID_KEY } from './session';
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
import { SDK_VERSION } from '../version';

export { IDENTITY_KEY as LINKSQUARED_STORAGE_KEY };
const OPENS_KEY = 'grovs_opens';
const LAST_START_KEY = 'grovs_last_start';

/**
 * Everything the SDK writes to bulk storage, for consent migration and reset.
 * Imported from the modules that own them: string literals here would let a
 * rename silently stop reset() clearing a key.
 */
const BULK_KEYS = [
  OPENS_KEY,
  LAST_START_KEY,
  SESSION_ID_KEY,
  SESSION_ACTIVITY_KEY,
  QUEUE_STORAGE_KEY,
  STORED_PATH_KEY,
] as const;

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
  private readonly storage: SwitchableStorage;
  private identityStore: IdentityStore | null;
  private readonly api: ApiService;
  private readonly deeplinks: DeeplinkResolver;
  private readonly clock: Clock;
  private readonly session: SessionManager;
  private readonly queue: PersistedQueue;
  private readonly events: EventsHandler;
  private readonly custom: CustomEventsHandler;
  private readonly lifecycle: LifecycleTracker;
  private readonly aliases = new ScreenAliases();
  private readonly screens: AutoScreenTracker;
  private readonly autoStartEvents: boolean;
  private payments: PaymentEventsHandler | null = null;
  private pipelineStarted = false;
  private configureGeneration = 0;
  private readonly storageInjected: boolean;

  private enabled = true;
  /**
   * Gated by requireConsent. While false, resolveStorage is bypassed for an
   * in-memory store and no request leaves — so nothing is written to the
   * device and nothing reaches the backend.
   */
  private consentGranted: boolean;
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
    this.consentGranted = !this.config.requireConsent;
    this.storageInjected = deps.storage !== undefined;

    // Bulk storage is localStorage or memory — never a cookie. See
    // resolveBulkStorage for why that distinction is load-bearing.
    //
    // Consent pending means memory only: nothing reaches the device until
    // grantConsent(), and the switch below repoints every holder at once.
    const initialBulk = deps.storage
      ? deps.storage
      : this.consentGranted
        ? resolveBulkStorage(this.logger)
        : new MemoryStorage();
    this.storage = new SwitchableStorage(initialBulk);

    // An injected storage means a test harness. Otherwise the identifier
    // always gets the cookie + localStorage mirror, including in consent
    // mode once consent lands — it is the tier most exposed to the Safari
    // eviction the mirror exists to survive.
    this.identityStore = deps.storage
      ? null
      : this.consentGranted
        ? new IdentityStore(this.config.cookieDomain)
        : null;

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
      onHide: () => void this.events.flush(),
    });
    this.screens = new AutoScreenTracker({
      aliases: this.aliases,
      onScreen: (name) => this.custom.trackScreenView(name),
    });

    this.context.linksquaredId = this.readIdentity();
  }

  /**
   * Grants consent: swaps the in-memory store for real persistence, migrates
   * anything queued meanwhile, and authenticates.
   *
   * Events tracked before consent are kept in memory and sent afterwards
   * rather than discarded — the integrator asked for them, and a banner
   * answered thirty seconds late should not cost the whole visit.
   */
  async grantConsent(): Promise<boolean> {
    if (this.consentGranted) return this.context.authenticated;

    this.consentGranted = true;

    // One switch repoints the queue, session, deeplink resolver and counters
    // together. Migrating each holder separately is how the session and the
    // captured path previously got stranded on the memory store forever.
    this.storage.switchTo(resolveBulkStorage(this.logger), BULK_KEYS);
    // Merge before persisting. The queue was built over empty memory, so its
    // in-memory array knows nothing about events a previous visit left in
    // localStorage — and an unconditional write would erase them.
    this.queue.mergeFromStorage();

    // Consent mode deferred this; the identifier gets its mirror now — and
    // the existing value must be read back before authenticating. The
    // constructor read from the memory store, which was empty, so without
    // this a returning visitor authenticates with no LINKSQUARED header, the
    // backend mints a fresh identifier, and they are counted as a new install
    // rather than recognised.
    if (!this.identityStore && !this.storageInjected) {
      this.identityStore = new IdentityStore(this.config.cookieDomain);
      this.context.linksquaredId = this.identityStore.get();
    }

    return this.configure();
  }

  /**
   * Clears every stored identifier, the session, and the event queue, and
   * stops tracking. The SDK returns to its pre-consent state.
   */
  reset(): void {
    this.shutdown();
    this.queue.clear();
    this.session.reset();
    for (const key of BULK_KEYS) this.storage.remove(key);
    this.storage.remove(IDENTITY_KEY);
    this.identityStore?.clear();
    this.context.reset();
    this.pipelineStarted = false;
    this.identityDirty = false;
    this.receivedPayloads.length = 0;

    this.consentGranted = !this.config.requireConsent;
    if (!this.consentGranted) {
      // Consent revoked means back to memory-only. Leaving the durable store
      // attached would keep persisting after the user withdrew the permission
      // that allowed it — the specific guarantee consent mode sells.
      this.storage.switchTo(new MemoryStorage(), []);
      this.identityStore = null;
    }

    this.logger.info('SDK state cleared.');
  }

  async configure(): Promise<boolean> {
    // A second configure() supersedes this one. Without the check below, a
    // slow first call can complete afterwards and restart its timers,
    // lifecycle listeners and screen tracker — two clients, everything twice.
    const generation = ++this.configureGeneration;
    const superseded = (): boolean => generation !== this.configureGeneration;

    if (!this.consentGranted) {
      this.logger.info(
        'configure() is waiting for consent; call grantConsent() to start. ' +
          'Nothing has been stored or sent.',
      );
      return false;
    }

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

    if (superseded()) return false;

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

    if (superseded()) return false;
    if (this.autoStartEvents) this.startEventPipeline(hadIdentity);

    await this.fetchPayload();

    // Only now is the attribution path known, so only now may events leave.
    // Consume it: T2 split read from consume so the path could be retired
    // once used. Leaving it stored means a visitor who arrived via campaign A
    // keeps receiving A's payload, and keeps having later direct visits
    // attributed to A, indefinitely.
    this.events.onPathResolved(this.deeplinks.consumeStoredPath());

    if (this.identityDirty) void this.pushIdentity();

    // Automatic display is a console setting, so it has to happen without the
    // integrator calling anything — that is what "automatic" means, and iOS
    // ships it that way.
    if (this.autoStartEvents) void this.displayAutomaticMessages();

    return true;
  }

  /** Opens every message the console flagged for automatic display. */
  async displayAutomaticMessages(): Promise<void> {
    if (!this.enabled) return;
    const surface = this.messagesUI?.();
    if (!surface) return;
    await surface.displayAutomaticMessages();
  }

  /** Set by the facade, which owns the DOM surface. */
  messagesUI: (() => { displayAutomaticMessages: () => Promise<void> } | null) | null = null;

  /**
   * Emits the launch events and starts the flush timers.
   *
   * The open count and last-start stamp are read before being written, because
   * both decide which launch events fire: opens === 0 means install (or
   * reinstall, if an identifier survived), and a last start more than seven
   * days ago means reactivation.
   */
  private startEventPipeline(hadIdentity: boolean): void {
    // React strict mode and hot reload both call configure() twice. Without
    // this, launch events are emitted twice and the second start() overwrites
    // the interval handles, leaking two timers that flush forever. The
    // History patch has the same guard for the same reason (spec A7).
    if (this.pipelineStarted) return;
    this.pipelineStarted = true;

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

  /** Enterprise deployments only; a 404 reports the reason (spec B4). */
  logCustomPurchase(purchase: CustomPurchase): Promise<boolean> {
    this.payments ??= new PaymentEventsHandler(this);
    return this.payments.logCustomPurchase(purchase);
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
    return this.identityStore ? this.identityStore.get() : this.storage.get(IDENTITY_KEY);
  }

  private writeIdentity(value: string): void {
    if (this.identityStore) this.identityStore.set(value);
    else this.storage.set(IDENTITY_KEY, value);
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

  /**
   * Disabling stops the SDK, it does not merely mute it: timers are cleared,
   * lifecycle listeners detached, and the History patch released (spec A7).
   * A flag alone would leave two intervals and a global patch running in a
   * page that asked the SDK to stop.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;

    if (!enabled) {
      this.shutdown();
    } else if (this.context.authenticated) {
      this.lifecycle.start();
      if (this.config.autoTrackScreenViews) this.screens.start();
      this.events.resume();
    }

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

  /**
   * Reports a call made before the SDK was usable, once per method.
   *
   * During server rendering every public method lands here, and a page that
   * renders repeatedly would otherwise report the same failure on every pass.
   * Spec A5 fixes the code set at four, so this reuses the closest one rather
   * than inventing a fifth.
   */
  reportUnavailable(method: string, code: GrovsError, message: string): void {
    this.logger.reportErrorOnce(method, code, message);
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
      // A web page has no build number, so `build` carries the SDK version and
      // `app_version` the host app's, defaulting to the same. Both are
      // free-form strings server-side; the literal "0" v1 sent was useless.
      app_version: this.config.appVersion,
      build: SDK_VERSION,
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
