import { ENRICHMENT_LIMITS } from '../contract/event-contract';
import { byteLength } from '../core/bytes';
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
  if (!properties || typeof properties !== 'object') return undefined;

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
  // The 8 KB cap is checked on the output, so the walk itself has to be
  // bounded: a small graph with shared references expands into a tree that
  // can hold the host page's main thread for hundreds of milliseconds.
  const budget = { values: MAX_VALUES };

  for (const key of keys) {
    if (budget.values < 0) break;
    const safe = safely(() => jsonSafeValue(properties[key], seen, budget));
    if (safe === DROP) dropped.push(key);
    else sanitized[key] = safe;
  }

  if (budget.values < 0) {
    logger?.warn('Custom event properties are too large to encode; dropping properties.');
    return undefined;
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

/** Distinguishes "this value must be dropped" from a legitimate null. */
const DROP = Symbol('drop');

/** More values than could ever fit in 8 KB; past it the walk stops. */
const MAX_VALUES = 10_000;

interface Budget {
  values: number;
}

/** A throwing getter costs its key, not the event or the caller's track(). */
function safely(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return DROP;
  }
}

function jsonSafeValue(value: unknown, seen: WeakSet<object>, budget: Budget): unknown {
  // Spent means stop: every loop above checks before its next element, so a
  // wide container ends here rather than being walked to the end.
  if (--budget.values < 0) return DROP;
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
          if (budget.values < 0) break;
          const item = safely(() => jsonSafeValue(value[i], seen, budget));
          if (item !== DROP) items.push(item);
        }
        return items;
      }

      const record = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        if (budget.values < 0) break;
        const safe = safely(() => jsonSafeValue(record[key], seen, budget));
        if (safe !== DROP) result[key] = safe;
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }

  return DROP;
}
