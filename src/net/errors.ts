/**
 * Mirrors GrovsError in Sources/Grovs/Grovs.swift. The numeric values are the
 * contract — integrators switch on them — so they must not be reordered.
 *
 * The SSR no-op reuses networkRequestFailed rather than a code iOS does not have.
 */
export enum GrovsError {
  authenticationFailed = 1,
  networkRequestFailed = 2,
  eventDispatchFailed = 3,
  linkGenerationFailed = 4,
  inAppDisplayFailed = 5,
}

const NAMES: Record<GrovsError, string> = {
  [GrovsError.authenticationFailed]: 'authentication_failed',
  [GrovsError.networkRequestFailed]: 'network_request_failed',
  [GrovsError.eventDispatchFailed]: 'event_dispatch_failed',
  [GrovsError.linkGenerationFailed]: 'link_generation_failed',
  [GrovsError.inAppDisplayFailed]: 'in_app_display_failed',
};

export function grovsErrorName(code: GrovsError): string {
  return NAMES[code];
}
