import type { Storage } from '../storage/storage';

export const GROVS_QUERY_PARAM = 'Grovs';
/** Appended by the redirect page alongside `Grovs` for the legacy SDK. */
export const LEGACY_QUERY_PARAM = 'linksquared';
export const STORED_PATH_KEY = 'Grovs_path';

/**
 * `Grovs` wins; `linksquared` and case variants of either are accepted so a
 * legacy integration or a case-mangled URL (email scanners rewrite them)
 * still attributes instead of silently falling back to fingerprinting.
 */
function readPathParam(params: URLSearchParams): string | null {
  const exact = params.get(GROVS_QUERY_PARAM) ?? params.get(LEGACY_QUERY_PARAM);
  if (exact !== null) return exact;
  for (const [key, value] of params) {
    const lower = key.toLowerCase();
    if (lower === 'grovs' || lower === 'linksquared') return value;
  }
  return null;
}

/**
 * Extracts and persists the Grovs path from the page URL.
 *
 * Spec T2. v1's getGrovsPath() deleted the stored value as a side effect of
 * reading it (grovs_device_details.js:112-115) while three call sites read it
 * per page load, so whichever ran second got null and silently skipped
 * attribution. Removing the delete alone is the mirror-image bug — the path
 * would outlive its visit and misattribute every later session — so reading
 * and consuming are separate operations with separate names.
 */
export class DeeplinkResolver {
  constructor(
    private readonly storage: Storage,
    private readonly currentUrl: () => string | null,
  ) {}

  /** Reads the query parameter, persists it, and returns it. Falls back to
   *  whatever was already stored when the current URL carries no parameter. */
  capture(): string | null {
    const href = this.currentUrl();
    if (!href) return null;

    let value: string | null = null;
    try {
      value = readPathParam(new URL(href).searchParams);
    } catch {
      return this.getStoredPath();
    }

    if (value === null) return this.getStoredPath();

    // URLSearchParams already decodes once; v1 decoded a second time, which
    // corrupted any path containing a literal percent sign.
    this.storage.set(STORED_PATH_KEY, value);
    return value;
  }

  /** Pure read. Safe to call any number of times. */
  getStoredPath(): string | null {
    return this.storage.get(STORED_PATH_KEY);
  }

  /** Reads and clears. Call exactly once, when the path has been attributed. */
  consumeStoredPath(): string | null {
    const value = this.storage.get(STORED_PATH_KEY);
    if (value !== null) this.storage.remove(STORED_PATH_KEY);
    return value;
  }
}
