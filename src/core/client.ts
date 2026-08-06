import { Logger, type LogLevel } from '../logging/logger';
import { GrovsError } from '../net/errors';
import { ApiService, type DeviceDetails } from '../net/api';
import { FetchTransport } from '../net/fetch-transport';
import type { Transport } from '../net/transport';
import { DeeplinkResolver } from '../links/deeplink';
import { resolveStorage, type Storage } from '../storage/storage';
import { getNavigator, getPageIdentifier, getWindow, isBrowser } from './environment';
import { resolveConfig, type GrovsConfig, type ResolvedConfig } from './config';
import { Context } from './context';

export const LINKSQUARED_STORAGE_KEY = 'linksquared';

export interface ClientDeps {
  transport?: Transport;
  storage?: Storage;
}

export class GrovsClient {
  private readonly config: ResolvedConfig;
  private readonly logger = new Logger();
  private readonly context = new Context();
  private readonly storage: Storage;
  private readonly api: ApiService;
  private readonly deeplinks: DeeplinkResolver;

  private enabled = true;
  private readonly receivedPayloads: Record<string, unknown>[] = [];
  /** True when identity was set before authentication finished, so it still
   *  needs pushing. Mirrors shouldUpdateIdentifiers in v1's manager. */
  private identityDirty = false;

  constructor(config: GrovsConfig, deps: ClientDeps = {}) {
    this.config = resolveConfig(config);
    this.logger.setLevel(this.config.debugLevel);
    this.logger.setOnError(this.config.onError);

    this.storage = deps.storage ?? resolveStorage(this.logger, this.config.cookieDomain);
    this.api = new ApiService(
      this.config,
      this.context,
      deps.transport ?? new FetchTransport(),
      () => getPageIdentifier(),
    );
    this.deeplinks = new DeeplinkResolver(this.storage, () => getWindow()?.location.href ?? null);

    this.context.linksquaredId = this.storage.get(LINKSQUARED_STORAGE_KEY);
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
    if (linksquaredId) {
      this.context.linksquaredId = linksquaredId;
      this.storage.set(LINKSQUARED_STORAGE_KEY, linksquaredId);
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

    await this.fetchPayload();
    if (this.identityDirty) void this.pushIdentity();

    return true;
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

  private deviceDetails(): DeviceDetails {
    return {
      user_agent: getNavigator()?.userAgent ?? '',
      // Phase 1 replaces these with the real fingerprint set the backend
      // accepts (spec B5); v1 hardcoded "0" and so does this port.
      app_version: '0',
      build: '0',
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
