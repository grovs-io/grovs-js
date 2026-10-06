import { byteLength } from '../core/bytes';
import type { SmartBannerLinkBody } from '../net/api';

export interface SmartBannerLinkData {
  page_path?: string;
  data?: Record<string, unknown>;
}

export interface LinkPayload {
  body: SmartBannerLinkBody;
  /** Canonical stored payload; the session-cache and in-flight key. */
  key: string;
}

type LinkValue = string | number | boolean;

const MAX_PAGE_PATH = 512;
const MAX_KEYS = 20;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 512;
const MAX_BYTES = 4096;

function validValue(value: unknown): value is LinkValue {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= MAX_VALUE_LENGTH)
  );
}

function validPagePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_PAGE_PATH &&
    value.startsWith('/')
  );
}

/** Null when the payload breaks a server rule; the default link is used instead. */
export function buildPayload(input: SmartBannerLinkData | null, pathname: string): LinkPayload | null {
  const raw = input?.data ?? {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const data: Record<string, LinkValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    // `{ id: product?.id }` is common: absent values are dropped, not refused.
    if (value === undefined || value === null) continue;
    if (key.length > MAX_KEY_LENGTH || !validValue(value)) return null;
    data[key] = value;
  }
  if (Object.keys(data).length > MAX_KEYS) return null;

  const pagePath = input?.page_path ?? pathname;
  const stored: Record<string, unknown> = { page_path: pagePath, ...data };
  if (!validPagePath(pagePath) || !validPagePath(stored['page_path'])) return null;

  const key = JSON.stringify(Object.fromEntries(Object.keys(stored).sort().map((k) => [k, stored[k]])));
  if (byteLength(key) > MAX_BYTES) return null;

  return { body: { page_path: pagePath, data }, key };
}
