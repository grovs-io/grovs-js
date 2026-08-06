import type { ErrorCallback, LogLevel } from '../logging/logger';
import { SDK_VERSION } from '../version';

export type DeeplinkCallback = (payload: Record<string, unknown>) => void;

const DEFAULT_BASE_URL = 'https://sdk.sqd.link';
const API_PATH = '/api/v1/sdk';

export interface GrovsConfig {
  apiKey: string;
  testEnvironment?: boolean;
  /** Custom API domain for self-hosted backends. The SDK appends the API path. */
  baseURL?: string;
  /** Opt-in cross-subdomain cookie scope (spec T11). Host-only when absent. */
  cookieDomain?: string;
  /** SPA route changes fire screen views automatically. Defaults to true,
   *  matching iOS. */
  autoTrackScreenViews?: boolean;
  /**
   * When true, nothing is persisted or transmitted until grantConsent() is
   * called; events accumulate in memory meanwhile. Defaults to false, which
   * preserves v1 behaviour — an integrator who upgrades without reading the
   * changelog must not silently lose data.
   */
  requireConsent?: boolean;
  /** Your app's version, reported with the device fingerprint. Defaults to
   *  the SDK version, since a web page has no build number of its own. */
  appVersion?: string;
  debugLevel?: LogLevel;
  onDeeplink?: DeeplinkCallback;
  onError?: ErrorCallback;
}

export interface ResolvedConfig {
  apiKey: string;
  testEnvironment: boolean;
  endpoint: string;
  cookieDomain?: string;
  autoTrackScreenViews: boolean;
  requireConsent: boolean;
  appVersion: string;
  debugLevel: LogLevel;
  onDeeplink: DeeplinkCallback | null;
  onError: ErrorCallback | null;
}

export function resolveConfig(input: GrovsConfig): ResolvedConfig {
  const apiKey = input.apiKey?.trim() ?? '';
  if (!apiKey) {
    throw new Error(
      'Grovs — API key is required. Use the value from the web console at https://app.grovs.io.',
    );
  }

  const base = (input.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  const resolved: ResolvedConfig = {
    apiKey,
    testEnvironment: input.testEnvironment ?? false,
    endpoint: `${base}${API_PATH}`,
    autoTrackScreenViews: input.autoTrackScreenViews ?? true,
    requireConsent: input.requireConsent ?? false,
    appVersion: input.appVersion?.trim() || SDK_VERSION,
    debugLevel: input.debugLevel ?? 'error',
    onDeeplink: input.onDeeplink ?? null,
    onError: input.onError ?? null,
  };
  if (input.cookieDomain) resolved.cookieDomain = input.cookieDomain;
  return resolved;
}
