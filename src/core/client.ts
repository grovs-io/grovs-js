import { Logger, type LogLevel } from '../logging/logger';
import { GrovsError } from '../net/errors';
import { ApiService, type DeviceDetails } from '../net/api';
import { FetchTransport } from '../net/fetch-transport';
import type { Transport } from '../net/transport';
import { DeeplinkResolver, STORED_PATH_KEY } from '../links/deeplink';
import type { Storage } from '../storage/storage';
import { MemoryStorage } from '../storage/memory-storage';
import { resolveBulkStorage, SwitchableStorage } from '../storage/bulk-storage';
import { LocalStorageAdapter } from '../storage/local-storage';
import { ScopedStorage } from '../storage/scoped-storage';
import { projectKey } from '../net/headers';
import { IdentityStore, LINKSQUARED_STORAGE_KEY as IDENTITY_KEY } from '../storage/identity';
import { PersistedQueue, QUEUE_STORAGE_KEY } from '../storage/persisted-queue';
import { EventsHandler } from '../events/events-handler';
import { CustomEventsHandler } from '../events/custom-events-handler';
import { PaymentEventsHandler, type CustomPurchase } from '../events/payment-events-handler';
import { LifecycleTracker } from '../tracking/lifecycle';
import { AutoScreenTracker, type ScreenNameProvider } from '../tracking/auto-screen-tracker';
import { ScreenAliases } from '../tracking/screen-aliases';
import {
  SessionManager,
  hasActiveSession,
  SESSION_ACTIVITY_KEY,
  SESSION_ID_KEY,
} from './session';
import { SystemClock, type Clock } from './clock';
import {
  getFingerprint,
  getNavigator,
  getPageIdentifier,
  getWindow,
  isBrowser,
  getLocalStorage,
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

/**
 * Keys carried across by the consent switch.
 *
 * The queue is excluded deliberately: once the persist debounce has fired,
 * the pre-consent memory store holds a queue of its own, and copying it would
 * overwrite whatever an earlier visit left in localStorage *before* the merge
 * could read it. The queue is merged separately, which keeps both sides.
 */
const SWITCH_KEYS = BULK_KEYS.filter((key) => key !== QUEUE_STORAGE_KEY);

/** The only legacy (unscoped) state carried into a project scope — see
 *  adoptLegacyState. */
const LEGACY_CARRIED: readonly string[] = [OPENS_KEY, LAST_START_KEY];

/** Authentication retries after a network or server failure: bounded, so a
 *  page left open does not poll a dead backend for ever. */
const AUTH_RETRY_DELAY_MS = 30_000;
const MAX_AUTH_RETRIES = 3;

/** The same, minus the session: used when the durable store already holds a
 *  live one. A session is a person, not a tab (spec A6), so this tab's
 *  memory-only session must not be written over a sibling's active one. */
const SWITCH_KEYS_KEEPING_SESSION = SWITCH_KEYS.filter(
  (key) => key !== SESSION_ID_KEY && key !== SESSION_ACTIVITY_KEY,
);

/**
 * The store used while consent is pending, shared across clients.
 *
 * Consent mode promises that events tracked meanwhile are kept, not
 * discarded. A per-client store broke that on reconfigure: the old client
 * persisted into an object the replacement never saw, so anything tracked
 * before the second configure() vanished. Nothing here touches the device —
 * it is memory either way — so sharing it costs nothing and keeps the
 * promise. Granting consent migrates it to localStorage as before.
 */
let pendingConsentStore: MemoryStorage | null = null;

/**
 * Whether this page load has already emitted its launch events.
 *
 * `pipelineStarted` guards one client; the facade's second configure() builds
 * a *new* one, which read the open counter again and reported a second
 * app_open for the same visit — the React strict mode case the facade exists
 * to absorb. Cleared by reset(), which is a new visitor by definition.
 */
const launchEmitted = new Set<string>();

/** Test seam: both outlive individual clients. */
export function __resetPendingConsentStore(): void {
  pendingConsentStore = null;
  launchEmitted.clear();
}

/**
 * @internal Test seams, not integrator API — reaches the public .d.ts only
 * because the v1 constructor signature carries it.
 */
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
  /** An initialization that started but never finished — see setEnabled. */
  private initStarted = false;
  private initComplete = false;
  private configureGeneration = 0;
  private disposed = false;
  private readonly storageInjected: boolean;
  /** Namespaces bulk storage per project — see ScopedStorage. */
  private readonly storageScope: string;

  /**
   * The attribution path for this visit.
   *
   * The durable copy is consumed once resolved, so it cannot follow the
   * visitor into later direct visits. This in-memory copy is what events are
   * stamped with for the rest of the session — reading the durable one after
   * the consume returned null, which left everything after configure()
   * unattributed.
   */
  private sessionPath: string | null = null;

  private enabled = true;
  /**
   * Gated by requireConsent. While false, every tier is swapped for an
   * in-memory store and no request leaves — so nothing is written to the
   * device and nothing reaches the backend.
   */
  private consentGranted: boolean;
  private readonly receivedPayloads: Record<string, unknown>[] = [];
  /**
   * Which identity fields the integrator has set and the backend has not yet
   * acknowledged. Tracked per field: one flag for both let setUserAttributes()
   * before authentication block the server's existing identifier from being
   * adopted, and the push that followed then cleared it with sdk_identifier: null.
   */
  private readonly identityDirty = { identifier: false, attributes: false };
  /** Same catch-up for screen aliases set before authentication (spec B8). */
  private aliasesDirty = false;
  /** As identityRevision: an older sync's success must not clear the flag
   *  for a newer map. */
  private aliasesRevision = 0;
  /** The tail of the identity-update chain — see pushIdentity. */
  private identityPush: Promise<void> = Promise.resolve();
  /** Same for alias syncs: two in flight could be processed out of order. */
  private aliasSync: Promise<void> = Promise.resolve();
  private authRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private authRetries = 0;
  /** Wall-clock deadline from a server's Retry-After, honoured by the timer
   *  and by the reconnect alike. */
  private authRetryNotBefore = 0;
  /** Connectivity is back: drain what queued offline, or finish authenticating. */
  private readonly onOnline = (): void => {
    // A delay the *server* named holds even here: a reconnect that cancels
    // the wait and fires immediately is the amplification Retry-After exists
    // to prevent, and worse than the timer because every tab reconnects at
    // once. Our own backoff does not hold — coming back online is exactly
    // when a request that failed on a dead connection should be retried.
    if (this.clock.now() < this.authRetryNotBefore) return;
    if (this.context.authenticated) this.events.flushIfDue();
    else this.retryAuthentication();
  };
  /**
   * Another tab called reset(): its identity mirror was removed. This tab
   * holds the same visitor in memory and would keep sending as them, and
   * would write the queue it was told to erase back into storage. Listened
   * for from construction to disposal, so a tab mid-authentication, disabled,
   * or retrying is covered too.
   *
   * A throttled background tab can receive the event minutes late, after the
   * other tab has authenticated again. The device then holds a new visitor,
   * and wiping it would reset that tab in turn — so when the mirror already
   * holds a value only this tab's memory is cleared.
   */
  private readonly onStorage = (event: StorageEvent): void => {
    if (event.key !== IDENTITY_KEY || event.newValue !== null) return;
    // A background tab can be handed this event minutes late, after this
    // client has already authenticated as the *next* visitor. The event names
    // the identity that was removed; if that is not the one held now, the
    // reset it describes has already been lived through.
    const removed = event.oldValue;
    if (removed !== null && this.context.linksquaredId !== null && removed !== this.context.linksquaredId) {
      return;
    }
    // No state gate: a tab waiting on an authentication retry, or not yet
    // configured, still holds the erased identifier in memory and would send
    // it — and the backend echoes what it is sent.
    this.logger.info('Reset by another tab.');
    this.resetState(this.identityStore?.get() === null);
  };
  /** Bumped by every setter. An acknowledgement clears the dirty flag only
   *  when it carries the newest one — see sendIdentity. */
  private identityRevision = 0;

  constructor(config: GrovsConfig, deps: ClientDeps = {}) {
    this.config = resolveConfig(config);
    this.logger.setLevel(this.config.debugLevel);
    this.logger.setOnError(this.config.onError);

    this.clock = deps.clock ?? new SystemClock();
    this.autoStartEvents = deps.autoStartEvents ?? true;
    this.consentGranted = !this.config.requireConsent;
    this.storageInjected = deps.storage !== undefined;
    this.storageScope = projectKey(this.config);

    // Bulk storage is localStorage or memory — never a cookie. See
    // resolveBulkStorage for why that distinction is load-bearing.
    //
    // Consent pending means memory only: nothing reaches the device until
    // grantConsent(), and the switch below repoints every holder at once.
    // An injected store is a test harness and is used as given.
    const initialBulk = deps.storage
      ? deps.storage
      : this.consentGranted
        ? this.adoptLegacyState(resolveBulkStorage(this.logger))
        : this.scoped((pendingConsentStore ??= new MemoryStorage()));
    this.storage = new SwitchableStorage(initialBulk);

    // An injected storage means a test harness. Otherwise the identifier
    // always gets the cookie + localStorage mirror, including in consent
    // mode once consent lands — it is the tier most exposed to the Safari
    // eviction the mirror exists to survive.
    this.identityStore = deps.storage
      ? null
      : this.consentGranted
        ? new IdentityStore(this.config.cookieDomain, this.logger)
        : null;

    this.api = new ApiService(
      this.config,
      this.context,
      deps.transport ?? new FetchTransport(),
      () => getPageIdentifier(),
      // Bound to the lifecycle as it was when the request left. reset() moves
      // the generation without withdrawing consent in the default
      // configuration, and its retries were still sending the visitor id it
      // had just cleared. The attempt in flight cannot be recalled; the
      // retries behind it can.
      () => {
        const generation = this.configureGeneration;
        return () =>
          generation !== this.configureGeneration ||
          !this.consentGranted ||
          !this.enabled ||
          this.disposed;
      },
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
      currentPath: () => this.sessionPath,
      isEnabled: () => this.enabled,
      isActive: () => this.isActive(),
      canTransmit: () => this.canTransmit(),
    });
    this.custom = new CustomEventsHandler({
      events: this.events,
      session: this.session,
      clock: this.clock,
      logger: this.logger,
      currentPath: () => this.sessionPath,
    });
    this.lifecycle = new LifecycleTracker({
      clock: this.clock,
      onEngagement: (seconds) => this.events.log('time_spent', seconds),
      // pagehide fires first on every unload and visibilitychange follows
      // (HTML's unloading steps), so the request goes out from the hide;
      // Firefox drops requests issued from pagehide, and sending from both
      // races the two handlers. Here only the debounced queue reaches disk.
      onExit: () => this.queue.flushToStorage(),
      onForeground: () => {
        this.session.currentSessionId();
      },
      onHide: () => {
        // The keepalive batch first: it is what survives if this hide is the
        // start of a close, and every browser gives the hidden transition
        // more time than the pagehide. Then persist (spec A4): on mobile
        // Safari a hidden tab is often killed with no pagehide.
        this.events.flushOnExit();
        this.queue.flushToStorage();
      },
    });
    this.screens = new AutoScreenTracker({
      aliases: this.aliases,
      // Through the guarded wrapper: a provider or alias that is not a
      // string would otherwise throw from a timer on every route change.
      onScreen: (name) => this.trackScreenView(name),
    });

    this.context.linksquaredId = this.readIdentity();
    // Both listeners live for the client's whole life, added and removed in
    // exactly one place each. Adding one here and dropping it somewhere else
    // is how the reconnect flush went quiet after an authentication retry.
    // Neither acts on a client that is disabled, reset or retired: onOnline
    // routes through flush(), which checks, and retryAuthentication checks.
    getWindow()?.addEventListener('storage', this.onStorage);
    getWindow()?.addEventListener('online', this.onOnline);
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
    // "Disabling stops the SDK, it does not merely mute it" — so granting
    // consent to a disabled SDK must not authenticate, fetch attribution and
    // start timers behind its back.
    if (!this.enabled) {
      this.logger.warn('grantConsent() ignored: the SDK is disabled.');
      return false;
    }

    if (this.consentGranted) return this.context.authenticated;

    this.consentGranted = true;

    // One switch repoints the queue, session, deeplink resolver and counters
    // together. Migrating each holder separately is how the session and the
    // captured path previously got stranded on the memory store forever.
    const durable = this.adoptLegacyState(resolveBulkStorage(this.logger));
    const sibling = hasActiveSession(durable, this.clock.now());
    const pendingSession = sibling ? this.session.currentSessionId() : null;

    this.storage.switchTo(durable, sibling ? SWITCH_KEYS_KEEPING_SESSION : SWITCH_KEYS);

    // Joining the session already in progress, so the events tracked before
    // consent belong to it rather than to the memory-only one they were
    // stamped with — otherwise this visit is reported as two.
    if (pendingSession !== null) {
      const adopted = this.session.currentSessionId();
      if (adopted !== pendingSession) {
        this.queue.transform((event) =>
          event.sessionId === pendingSession ? { ...event, sessionId: adopted } : event,
        );
      }
    }
    // Merge before persisting. The queue was built over empty memory, so its
    // in-memory array knows nothing about events a previous visit left in
    // localStorage — and an unconditional write would erase them.
    this.queue.mergeFromStorage();

    // Everything it held is now in localStorage. Leaving it populated means a
    // later configure({ requireConsent: true }) reads back events that were
    // already delivered — or that reset() was documented as having deleted.
    pendingConsentStore = null;

    // Consent mode deferred this; the identifier gets its mirror now — and
    // the existing value must be read back before authenticating. The
    // constructor read from the memory store, which was empty, so without
    // this a returning visitor authenticates with no LINKSQUARED header, the
    // backend mints a fresh identifier, and they are counted as a new install
    // rather than recognised.
    if (!this.identityStore && !this.storageInjected) {
      this.identityStore = new IdentityStore(this.config.cookieDomain, this.logger);
      this.context.linksquaredId = this.identityStore.get();
    }

    return this.configure();
  }

  /**
   * Clears every stored identifier, the session, and the event queue, and
   * stops tracking. The SDK returns to its pre-consent state.
   */
  reset(): void {
    this.resetState(true);
  }

  /** `wipeDurable` false clears this client's memory only — see onStorage. */
  private resetState(wipeDurable: boolean): void {
    // Bump first: a pending authenticate or payload lookup must not land
    // after the clear and re-authenticate the client it just wiped.
    this.configureGeneration += 1;
    // Before shutdown(), which persists: a stale queue written now would land
    // in the store the new visitor already owns.
    if (!wipeDurable) this.queue.discard();
    this.shutdown();
    // The list on screen belongs to the visitor being cleared.
    this.messagesUI?.()?.close();
    if (wipeDurable) {
      this.queue.clear();
      this.session.reset();
      for (const key of BULK_KEYS) this.storage.remove(key);
      this.storage.remove(IDENTITY_KEY);
      this.identityStore?.clear();
      this.clearDurableState();
    }
    this.authRetries = 0;
    // Otherwise a later consent-pending client reads back exactly what this
    // call was supposed to erase.
    pendingConsentStore = null;
    this.context.reset();
    this.custom.resetDedup();
    // The screen belongs to the visitor being cleared; the next screen view
    // sets it again for the new one.
    this.custom.resetScreenContext();
    // Or the next tracked event leaves under the previous configure()'s
    // permission, after the reset that was supposed to stop it.
    this.events.resetDelivery();
    this.pipelineStarted = false;
    launchEmitted.delete(this.storageScope);
    this.initStarted = false;
    this.initComplete = false;
    this.identityDirty.identifier = false;
    this.identityDirty.attributes = false;
    // aliasesDirty deliberately survives: the alias map is integrator
    // configuration, not user data — reset() does not clear this.aliases
    // either, and a pending dashboard sync should still happen on the next
    // configure().
    this.receivedPayloads.length = 0;
    // Durable Grovs_path is cleared above; the in-memory copy has to go too,
    // or events after the reset inherit the previous campaign.
    this.sessionPath = null;

    this.consentGranted = !this.config.requireConsent;
    if (!this.consentGranted) {
      // Consent revoked means back to memory-only. Leaving the durable store
      // attached would keep persisting after the user withdrew the permission
      // that allowed it — the specific guarantee consent mode sells. A fresh
      // *shared* store: empty, so nothing survives the reset, but still the
      // one a replacement client picks up, or events tracked between this
      // reset and the next configure() are stranded on a store nobody reads.
      pendingConsentStore = new MemoryStorage();
      this.storage.switchTo(this.scoped(pendingConsentStore), []);
      this.identityStore = null;
    }

    this.logger.info('SDK state cleared.');
  }

  async configure(): Promise<boolean> {
    // A second configure() supersedes this one. Without the check below, a
    // slow first call can complete afterwards and restart its timers,
    // lifecycle listeners and screen tracker — two clients, everything twice.
    const generation = ++this.configureGeneration;
    // `disposed` covers the facade case: Grovs.configure() builds a *new*
    // client, so the old one's counter never moves — only its shutdown does.
    const superseded = (): boolean => generation !== this.configureGeneration || this.disposed;

    // Captured before the consent gate. The store is memory until consent
    // lands, so nothing reaches the device — but a router that cleans the
    // query string while the banner is up takes the campaign with it.
    this.sessionPath = this.deeplinks.capture();

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

    this.initStarted = true;
    this.initComplete = false;

    // Read again, not only at construction: a reset in another tab since
    // then removed the identifier, and sending it would recreate it.
    if (!this.context.authenticated) this.context.linksquaredId = this.readIdentity();

    if (superseded()) return false;

    const response = await this.api.authenticate(this.deviceDetails());

    // Check before reporting: a superseded attempt's failure is not the
    // active configuration's failure, and firing onError for it sends the
    // integrator chasing a config that no longer exists.
    if (superseded()) return false;

    if (!response.ok) {
      this.reportAuthFailure(response.status, response.body);
      if (isTransient(response.status)) {
        // Still an initialization in progress: setEnabled(true) after a
        // disable during the retry window re-runs it.
        this.scheduleAuthRetry(response.retryAfterMs);
      } else {
        // Nothing was started that a later enable would need to finish, and
        // a re-run would report the same failure a second time.
        this.initStarted = false;
      }
      return false;
    }
    this.cancelAuthRetry();
    this.authRetries = 0;
    this.authRetryNotBefore = 0;

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
    if (!this.identityDirty.identifier) {
      this.context.userIdentifier =
        typeof body['sdk_identifier'] === 'string' ? body['sdk_identifier'] : null;
    }
    if (!this.identityDirty.attributes) {
      this.context.userAttributes =
        body['sdk_attributes'] && typeof body['sdk_attributes'] === 'object'
          ? (body['sdk_attributes'] as Record<string, unknown>)
          : null;
    }

    this.context.authenticated = true;
    this.logger.info('Authenticated.');

    if (superseded()) return false;
    if (this.autoStartEvents) this.startEventPipeline(hadIdentity);

    let resolved = false;
    try {
      resolved = await this.fetchPayload(superseded);
    } finally {
      // Unblock in a finally: a throwing onDeeplink callback would otherwise
      // leave pathResolved false for ever, and every flush for the rest of
      // the visit — and every later one, since the queue persists — silently
      // does nothing.
      //
      // A retired client skips it: onPathResolved transforms the queue and
      // schedules a write, which would rearm the debounce dispose() just
      // cancelled.
      if (!superseded()) this.events.onPathResolved(this.sessionPath);
    }

    if (superseded()) return false;

    // Retire the durable copy only once it has actually been attributed. A
    // 5xx or a dropped connection must not cost the campaign attribution;
    // the next page load retries with it. The in-memory copy carries the rest
    // of this visit either way.
    if (resolved) this.deeplinks.consumeStoredPath();

    if (this.hasPendingIdentity()) void this.pushIdentity();

    // As with pushIdentity: the flag clears only on success, so a failed
    // sync is retried by the next configure() rather than dropped.
    if (this.aliasesDirty) void this.syncAliases();

    // Automatic display is a console setting, so it has to happen without the
    // integrator calling anything — that is what "automatic" means, and iOS
    // ships it that way.
    if (this.autoStartEvents) void this.displayAutomaticMessages();

    this.initComplete = true;
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
  messagesUI:
    | (() => { displayAutomaticMessages: () => Promise<void>; close: () => void } | null)
    | null = null;

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

    if (launchEmitted.has(this.storageScope)) {
      // A replacement client for the same visit: timers and listeners still
      // need starting, the launch events do not.
      this.events.startTimers();
      this.lifecycle.start();
      if (this.config.autoTrackScreenViews) this.screens.start();
      return;
    }
    launchEmitted.add(this.storageScope);

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
    // An untyped caller passing the wrong shape gets a warning, not a throw
    // out of their own handler.
    try {
      this.custom.track(name, properties, tags);
    } catch (error) {
      this.logger.warn(`track() ignored: ${String(error)}`);
    }
  }

  trackScreenView(screenName: string, properties?: Record<string, unknown>): void {
    if (!this.enabled) return;
    try {
      this.custom.trackScreenView(screenName, properties);
    } catch (error) {
      this.logger.warn(`trackScreenView() ignored: ${String(error)}`);
    }
  }

  setGlobalTags(tags: string[] | null): void {
    this.events.setGlobalTags(tags);
  }

  /** Enterprise deployments only; a 404 reports the reason (spec B4). */
  logCustomPurchase(purchase: CustomPurchase): Promise<boolean> {
    this.payments ??= new PaymentEventsHandler(this);
    return this.payments.logCustomPurchase(purchase);
  }

  /** Syncs the map to the dashboard so aliases appear there too (spec B8). */
  setScreenAliases(aliases: Record<string, string>): void {
    if (!aliases || typeof aliases !== 'object') {
      this.logger.warn('setScreenAliases() expects an object; ignored.');
      return;
    }
    this.aliases.set(aliases, this.logger);
    // Pushed later otherwise: by configure() once authentication completes,
    // or by setEnabled(true) — a disabled SDK sends nothing.
    this.aliasesDirty = true;
    this.aliasesRevision += 1;
    if (this.enabled && this.context.authenticated) void this.syncAliases();
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

  /**
   * Stops timers and listeners. Reversible — reset() and setEnabled(false)
   * both use it, and the client can configure again afterwards.
   */
  shutdown(): void {
    // Persist and cancel the pending debounce. Without this a stopped client
    // still writes its queue a second later, over whatever replaced it.
    this.queue.flushToStorage();
    this.events.stop();
    this.lifecycle.stop();
    this.screens.stop();
    this.cancelAuthRetry();
  }

  /**
   * A visitor who loads the page while their connection or the backend is
   * down would otherwise stay unauthenticated until the next navigation;
   * events queue meanwhile, but launch events and time_spent are lost.
   */
  private scheduleAuthRetry(retryAfterMs?: number): void {
    if (this.authRetries >= MAX_AUTH_RETRIES) return;
    const win = getWindow();
    if (!win) return;
    this.authRetries += 1;
    // A throttled backend named a delay; waiting less than it asked for is
    // the amplification Retry-After exists to prevent.
    const delay = Math.max(AUTH_RETRY_DELAY_MS, retryAfterMs ?? 0);
    if (retryAfterMs) this.authRetryNotBefore = this.clock.now() + retryAfterMs;
    this.authRetryTimer = setTimeout(this.onOnline, delay);
  }

  private cancelAuthRetry(): void {
    if (this.authRetryTimer !== null) clearTimeout(this.authRetryTimer);
    this.authRetryTimer = null;
  }

  private retryAuthentication(): void {
    this.cancelAuthRetry();
    // initStarted is the question being asked: is there an initialization
    // waiting to finish? reset() clears it, and reset() means stopped until
    // the integrator configures again — coming back online is not consent.
    if (!this.initStarted) return;
    if (this.disposed || !this.enabled || this.context.authenticated) return;
    this.logger.info('Retrying authentication.');
    void this.configure();
  }

  /**
   * Everything on the device, whether or not this client has opened it: in
   * consent mode the client sits on a memory store and has no identity
   * store, but a previous visit's identifier and queue are still durable —
   * and reset() promises they are gone. Legacy unscoped keys included.
   */
  private clearDurableState(): void {
    if (this.storageInjected) return;
    // No write probe first: a full store still allows removals, and the
    // cookie does not depend on localStorage at all. Every call is guarded.
    const durable = new LocalStorageAdapter();
    const scoped = this.scoped(durable);
    for (const key of BULK_KEYS) {
      scoped.remove(key);
      durable.remove(key);
    }
    // Every project's queue, not only this one's. The visitor identifier is
    // deliberately shared across projects on an origin, so a queue left
    // behind under another project is re-sent under whatever identity the
    // next configure() mints — the previous visitor's events attributed to
    // the new one, which is the opposite of what reset() promises.
    removeScopedKeys(durable, BULK_KEYS);
    if (!this.identityStore) new IdentityStore(this.config.cookieDomain).clear();
  }

  /**
   * Retires this client permanently. Only the facade calls it, when a second
   * configure() replaces this instance.
   *
   * Kept separate from shutdown() deliberately: conflating the two made
   * reset() and setEnabled(false) brick the client, so withdrawing consent
   * and granting it again — the ordinary GDPR cycle both the README and
   * MIGRATION.md teach — authenticated and then silently returned false.
   */
  dispose(): void {
    this.disposed = true;
    // Queued identity and alias updates check the generation before they
    // send; a retired client must fail that check.
    this.configureGeneration += 1;
    this.shutdown();
    getWindow()?.removeEventListener('storage', this.onStorage);
    getWindow()?.removeEventListener('online', this.onOnline);
    // A response still in flight cannot be cancelled, but its handler can be
    // stopped from writing: otherwise a late batch acknowledgement persists
    // this client's stale snapshot over the replacement's queue.
    this.queue.freeze();
  }

  get eventsHandler(): EventsHandler {
    return this.events;
  }

  get sessionManager(): SessionManager {
    return this.session;
  }

  private scoped(store: Storage): Storage {
    return new ScopedStorage(store, this.storageScope);
  }

  /**
   * Builds written before storage was scoped left their state under bare
   * keys. The launch counters carry over — losing them costs a returning
   * visitor a spurious reinstall, since the identifier is shared and opens
   * would read 0. Everything else (queue, session, path) belonged to
   * whichever project wrote it, which cannot be known now, so it is dropped
   * rather than sent under this one. Removal waits for a confirmed copy.
   */
  private adoptLegacyState(durable: Storage): Storage {
    const scoped = this.scoped(durable);
    for (const key of BULK_KEYS) {
      const legacy = durable.get(key);
      if (legacy === null) continue;
      const carry = LEGACY_CARRIED.includes(key) && scoped.get(key) === null;
      if (!carry || scoped.set(key, legacy)) durable.remove(key);
    }
    return scoped;
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
    this.identityDirty.identifier = true;
    this.markIdentityChanged();
  }

  setUserAttributes(value: Record<string, unknown> | null): void {
    if (value !== null && typeof value !== 'object') {
      this.logger.warn('setUserAttributes() expects an object or null; ignored.');
      return;
    }
    this.context.userAttributes = value;
    this.identityDirty.attributes = true;
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
      // As with reset: an authenticate still in flight would otherwise
      // complete and start the intervals, lifecycle listeners and History
      // patch on a client that has been told to stop.
      this.configureGeneration += 1;
      this.shutdown();
    } else {
      if (this.context.authenticated) {
        this.lifecycle.start();
        if (this.config.autoTrackScreenViews) this.screens.start();
        this.events.resume();
        // Only configure() consumed this before, and the facade's configure()
        // builds a *new* client — so an identifier set while stopped sat in
        // the context until the next page load read the server value over it.
        if (this.hasPendingIdentity()) void this.pushIdentity();
        if (this.aliasesDirty) void this.syncAliases();
      }

      // Finish an initialization disabling interrupted, rather than resuming
      // half of one: authenticated with pathResolved never set is a client
      // whose timers tick and whose flushes send nothing. Emitting the launch
      // events twice is covered by the pipelineStarted guard.
      if (this.initStarted && !this.initComplete) void this.configure();
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
   * Whether this client is still the one that should be acting.
   *
   * dispose() retires it permanently; reset() and setEnabled(false) invalidate
   * whatever was in flight without retiring it. Every await that can be
   * followed by a side effect checks this — otherwise a continuation from
   * before the change lands after it, which is how a reset client
   * re-authenticated itself and a disabled one restarted its timers.
   */
  isActive(): boolean {
    return !this.disposed;
  }

  /**
   * Moves on every configure(), reset() and setEnabled(false).
   *
   * Callers that await a response capture it first and compare after: `usable`
   * alone goes true again when the SDK re-authenticates, which is exactly the
   * case where the response belongs to the previous visitor.
   */
  get lifecycleGeneration(): number {
    return this.configureGeneration;
  }

  /** Whether anything at all may leave the device right now. */
  private canTransmit(): boolean {
    return this.consentGranted && this.context.authenticated;
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

  private hasPendingIdentity(): boolean {
    return this.identityDirty.identifier || this.identityDirty.attributes;
  }

  /** The flag clears only on success, so a failed sync is retried by the
   *  next configure() or setEnabled(true) rather than dropped. */
  private syncAliases(): Promise<void> {
    const generation = this.configureGeneration;
    const revision = this.aliasesRevision;
    const abandon = (): boolean =>
      generation !== this.configureGeneration || !this.enabled || !this.canTransmit();
    // The catch keeps the chain usable, as pushIdentity's does: one rejection
    // would otherwise leave every later sync chained onto a rejected promise,
    // silently sending nothing for the rest of the page's life.
    this.aliasSync = this.aliasSync.then(async () => {
      if (abandon()) return;
      try {
        const ok = await this.aliases.sync(this.api, this.logger, abandon);
        if (ok && !abandon() && revision === this.aliasesRevision) this.aliasesDirty = false;
      } catch {
        this.logger.warn('Could not sync screen aliases to the dashboard.');
      }
    });
    return this.aliasSync;
  }

  private markIdentityChanged(): void {
    // The per-field flag is set by the setter and cleared only by an
    // acknowledgement, so it records the integrator's intent rather than being
    // inferred from the context later — setUserIdentifier(null) is an
    // instruction to clear, and reading the context back cannot tell that
    // from "nothing pending".
    this.identityRevision += 1;
    if (!this.enabled || !this.context.authenticated) return;
    void this.pushIdentity();
  }

  /** Serialized: two setters racing let the older response land last, leaving
   *  the backend holding the value the integrator had already replaced. */
  private pushIdentity(): Promise<void> {
    const generation = this.configureGeneration;
    const revision = this.identityRevision;
    // The catch keeps the chain usable: a transport that rejects rather than
    // resolving would otherwise leave every later update chained onto a
    // rejected promise, silently sending nothing.
    this.identityPush = this.identityPush.then(() =>
      this.sendIdentity(generation, revision).catch(() => {
        this.logger.reportError(
          GrovsError.networkRequestFailed,
          'Could not update the user identifier or attributes.',
        );
      }),
    );
    return this.identityPush;
  }

  private async sendIdentity(generation: number, revision: number): Promise<void> {
    // Checked here and not only when the send was scheduled: a queued update
    // runs after whatever happened while it waited, and it reads the context
    // as it is now. A reset in between must not be followed by a request
    // carrying the values set after it.
    if (generation !== this.configureGeneration || !this.canTransmit()) return;

    const response = await this.api.setUserAttributes();

    // And again after the await. This response describes the values as they
    // were when it left; a reset or a disable since means the context holds
    // something else, and clearing the flag on it would drop that instead.
    if (generation !== this.configureGeneration) return;

    // Cleared only here, and only by an acknowledgement that covers the newest
    // setter: two changes inside one request's flight would otherwise let the
    // first one's success clear the flag for the second, which is then
    // forgotten if it fails. Every other path — skipped, superseded, refused —
    // leaves the change owed, which is what configure() and setEnabled(true)
    // pick up.
    if (response.ok) {
      if (revision === this.identityRevision) {
        this.identityDirty.identifier = false;
        this.identityDirty.attributes = false;
      }
      return;
    }
    this.logger.reportError(
      GrovsError.networkRequestFailed,
      'Could not update the user identifier or attributes.',
    );
  }

  /** Returns whether the lookup completed, which is what licenses consuming
   *  the stored path. */
  private async fetchPayload(superseded: () => boolean = () => false): Promise<boolean> {
    const path = this.sessionPath;
    const details = this.deviceDetails();
    const response = path
      ? await this.api.payloadForDeviceAndPath(details, path)
      : await this.api.payloadForDevice(details);

    if (!response.ok) {
      // As with authenticate: a superseded attempt's failure is not the active
      // configuration's, and reporting it sends the integrator chasing a
      // config that no longer exists.
      if (superseded()) return false;
      this.logger.reportError(
        GrovsError.networkRequestFailed,
        'Could not fetch the deep link payload.',
      );
      return false;
    }

    const data = (response.body as Record<string, unknown> | null)?.['data'];
    if (!data || typeof data !== 'object') return true;

    // A client replaced mid-lookup must not hand the integrator a payload for
    // a configuration that no longer exists.
    if (superseded()) return false;

    const payload = data as Record<string, unknown>;
    this.receivedPayloads.push(payload);

    // The callback is the integrator's code. A throw from it must not take
    // down configure() or the event pipeline behind it.
    try {
      this.config.onDeeplink?.(payload);
    } catch {
      this.logger.error('The onDeeplink callback threw; continuing.');
    }

    return true;
  }

  /**
   * Spec B5. The backend's authenticate endpoint permits eleven parameters;
   * v1 sent three, two of them the literal string "0". The screen, timezone,
   * WebGL and language fields are a browser fingerprint, and fingerprint
   * matching is exactly what `data_for_device` → `resolve_by_fingerprint`
   * uses to resolve a deferred deep link — so sending three fields left web
   * deferred deep linking matching on almost no signal.
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
    // The first failure and the last retry reach onError; transient ones
    // between are logged, so an outage is one report at each end rather than
    // four. A permanent answer during a retry is reported: nothing follows it.
    if (this.authRetries > 0 && this.authRetries < MAX_AUTH_RETRIES && isTransient(status)) {
      this.logger.info(`Authentication retry ${this.authRetries} failed (HTTP ${status}).`);
      return;
    }
    const rawError = (body as Record<string, unknown> | null)?.['error'];
    // A 2xx only reaches here when the transport could not read the body, and
    // "HTTP 200" sends the integrator looking at a server that answered fine.
    const serverMessage =
      typeof rawError === 'string'
        ? rawError
        : status >= 200 && status < 300
          ? `The server answered ${status} with a body the SDK could not read.`
          : `HTTP ${status}`;

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

/** Worth retrying: no connection, a timeout, throttling, or a server error. */
function isTransient(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/**
 * Removes every project's copy of the given keys.
 *
 * ScopedStorage writes `<key>:<project>`, so this enumerates the store rather
 * than guessing project names. Guarded: a store can refuse enumeration the
 * same way it refuses a write.
 */
function removeScopedKeys(durable: Storage, keys: readonly string[]): void {
  const raw = getLocalStorage();
  if (!raw) return;
  const doomed: string[] = [];
  try {
    for (let i = 0; i < raw.length; i += 1) {
      const key = raw.key(i);
      if (key && keys.some((base) => key.startsWith(`${base}:`))) doomed.push(key);
    }
  } catch {
    return;
  }
  for (const key of doomed) durable.remove(key);
}
