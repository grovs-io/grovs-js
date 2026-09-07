import { ENRICHMENT_LIMITS } from '../contract/event-contract';
import type { Logger } from '../logging/logger';

/**
 * Turns user-supplied properties into a JSON-safe object.
 *
 * Ported from CustomEvent.sanitizeProperties in the iOS SDK, with the same
 * rules: Date/URL coerced to strings, values that cannot be represented in
 * JSON dropped *per key* so one bad value never discards the whole set, and
 * the encoded result capped at 8 KB to match MAX_PROPERTIES_BYTES.
 *
 * Dropping per key rather than per event matters: an analytics call that
 * silently loses everything because one field held a circular reference is
 * indistinguishable from one that was never made.
 */
export function sanitizeProperties(
  properties: Record<string, unknown> | undefined,
  logger?: Logger,
): Record<string, unknown> | undefined {
  if (!properties) return undefined;

  // keys, not entries: entries reads every value, so one throwing getter kills all.
  const keys = Object.keys(properties);
  if (keys.length === 0) return undefined;

  const sanitized: Record<string, unknown> = {};
  const dropped: string[] = [];

  // One path-tracking set, seeded with the root, so a property pointing back
  // at the object it lives on is dropped at the first hop rather than copied
  // once and dropped at the second. jsonSafeValue removes what it adds on the
  // way out, so this tracks the current path only — a value referenced by two
  // sibling keys is still kept in both.
  const seen = new WeakSet<object>();
  seen.add(properties);

  for (const key of keys) {
    const safe = safely(() => jsonSafeValue(properties[key], seen));
    if (safe === DROP) dropped.push(key);
    else sanitized[key] = safe;
  }

  if (dropped.length > 0) {
    logger?.warn(
      `Dropped non-serializable custom event property value(s) for key(s): ${dropped
        .sort()
        .join(', ')}.`,
    );
  }

  if (Object.keys(sanitized).length === 0) return undefined;

  let encoded: string;
  try {
    encoded = JSON.stringify(sanitized);
  } catch {
    logger?.warn('Custom event properties could not be encoded; dropping properties.');
    return undefined;
  }

  if (byteLength(encoded) > ENRICHMENT_LIMITS.maxPropertiesBytes) {
    logger?.warn(
      `Custom event properties exceed ${ENRICHMENT_LIMITS.maxPropertiesBytes} bytes; ` +
        'dropping properties. The event is still recorded.',
    );
    return undefined;
  }

  return sanitized;
}

/**
 * UTF-8 byte length, not String.length.
 *
 * The backend measures `hash.to_json.bytesize`, and String.length counts
 * UTF-16 code units — so 8,000 CJK characters are 8,000 by one measure and
 * 24,000 by the other. Measuring the wrong one lets properties past a check
 * the backend then fails, which is the failure the local check exists to
 * prevent.
 */
export function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  return unescape(encodeURIComponent(value)).length;
}

/** Distinguishes "this value must be dropped" from a legitimate null. */
const DROP = Symbol('drop');

/** A throwing getter costs its key, not the event or the caller's track(). */
function safely(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return DROP;
  }
}

function jsonSafeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      return value;
    case 'number':
      // NaN and Infinity serialize to null, which would silently turn a broken
      // measurement into a real-looking one.
      return Number.isFinite(value) ? value : DROP;
    // Coerced like Date and URL rather than dropped: a bigint is a real
    // measurement and losing it silently is worse than sending it as a string.
    // Documented in the README alongside the other coercions.
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return DROP;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? DROP : value.toISOString();
  }
  if (value instanceof URL) return value.toString();

  if (typeof value === 'object') {
    // A cycle would make JSON.stringify throw and take the whole event with it.
    if (seen.has(value)) return DROP;
    seen.add(value);

    // finally, not a trailing delete: Object.keys throws on a hostile proxy, and
    // a stranded entry makes a later sibling reference look like a cycle.
    try {
      if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (let i = 0; i < value.length; i += 1) {
          const item = safely(() => jsonSafeValue(value[i], seen));
          if (item !== DROP) items.push(item);
        }
        return items;
      }

      const record = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        const safe = safely(() => jsonSafeValue(record[key], seen));
        if (safe !== DROP) result[key] = safe;
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }

  return DROP;
}
