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

  const entries = Object.entries(properties);
  if (entries.length === 0) return undefined;

  const sanitized: Record<string, unknown> = {};
  const dropped: string[] = [];

  // One path-tracking set, seeded with the root, so a property pointing back
  // at the object it lives on is dropped at the first hop rather than copied
  // once and dropped at the second. jsonSafeValue removes what it adds on the
  // way out, so this tracks the current path only — a value referenced by two
  // sibling keys is still kept in both.
  const seen = new WeakSet<object>();
  seen.add(properties);

  for (const [key, value] of entries) {
    const safe = jsonSafeValue(value, seen);
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

  if (encoded.length > ENRICHMENT_LIMITS.maxPropertiesBytes) {
    logger?.warn(
      `Custom event properties exceed ${ENRICHMENT_LIMITS.maxPropertiesBytes} bytes; ` +
        'dropping properties. The event is still recorded.',
    );
    return undefined;
  }

  return sanitized;
}

/** Distinguishes "this value must be dropped" from a legitimate null. */
const DROP = Symbol('drop');

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

    if (Array.isArray(value)) {
      const items = value.map((item) => jsonSafeValue(item, seen)).filter((item) => item !== DROP);
      seen.delete(value);
      return items;
    }

    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const safe = jsonSafeValue(nested, seen);
      if (safe !== DROP) result[key] = safe;
    }
    seen.delete(value);
    return result;
  }

  return DROP;
}
