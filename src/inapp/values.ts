/**
 * How values become text and how two values compare.
 *
 * Every rule here is one where JavaScript's default disagrees with Swift's
 * or Kotlin's, so none of it can be left to the language.
 */

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Expands "1e-7" and "1.5e+21": String() switches to an exponent that no other platform prints. */
function plain(value: number): string {
  const written = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(written);
  if (!match) return written;
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Null for anything with no text form every platform agrees on: null, lists, objects. */
export function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? plain(value === 0 ? 0 : value) : null;
  return null;
}

export function isNumber(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && NUMBER.test(value);
}

function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function same(actual: string, expected: string): boolean {
  if (isNumber(actual) && isNumber(expected)) return numberOf(actual) === numberOf(expected);
  return actual.toLowerCase() === expected.toLowerCase();
}

function between(actual: string, range: unknown): boolean {
  if (!Array.isArray(range) || range.length !== 2) return false;
  const [low, high] = range as [unknown, unknown];
  if (!isNumber(actual) || !isNumber(low) || !isNumber(high)) return false;
  const value = numberOf(actual);
  return value >= numberOf(low) && value <= numberOf(high);
}

export function compare(actualValue: unknown, operator: string, expectedValue: unknown): boolean {
  const actual = textOf(actualValue);
  const present = actual !== null && actual !== '';
  if (operator === 'is_not_set') return !present;
  if (!present) return false;
  if (operator === 'is_set') return true;
  if (operator === 'between') return between(actual, expectedValue);

  const expected = textOf(expectedValue);
  if (expected === null) return false;

  switch (operator) {
    case 'eq':
      return same(actual, expected);
    case 'neq':
      return !same(actual, expected);
    case 'gt':
      return isNumber(actual) && isNumber(expected) && numberOf(actual) > numberOf(expected);
    case 'lt':
      return isNumber(actual) && isNumber(expected) && numberOf(actual) < numberOf(expected);
    case 'contains':
      return actual.toLowerCase().includes(expected.toLowerCase());
    case 'not_contains':
      return !actual.toLowerCase().includes(expected.toLowerCase());
    default:
      return false;
  }
}

function versionParts(version: string): number[] {
  const kept = /^[\d.]*/.exec(version)?.[0] ?? '';
  return kept.split('.').map((part) => (part === '' ? 0 : Number(part)));
}

function versionOrder(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const size = Math.max(a.length, b.length);
  for (let i = 0; i < size; i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function compareVersions(actual: unknown, operator: string, expected: unknown): boolean {
  const version = textOf(actual);
  if (version === null || version === '') return false;
  if (operator === 'between') {
    if (!Array.isArray(expected) || expected.length !== 2) return false;
    const [low, high] = expected as [unknown, unknown];
    return versionOrder(version, String(low)) >= 0 && versionOrder(version, String(high)) <= 0;
  }
  const order = versionOrder(version, String(expected));
  switch (operator) {
    case 'eq':
      return order === 0;
    case 'neq':
      return order !== 0;
    case 'gt':
      return order > 0;
    case 'lt':
      return order < 0;
    default:
      return false;
  }
}

/** encodeURIComponent throws on half of a surrogate pair, which user-supplied text can hold. */
function wellFormed(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    const high = unit >= 0xd800 && unit <= 0xdbff;
    const low = unit >= 0xdc00 && unit <= 0xdfff;
    const next = value.charCodeAt(i + 1);
    if (high && next >= 0xdc00 && next <= 0xdfff) {
      out += value.charAt(i) + value.charAt(i + 1);
      i += 1;
    } else {
      out += high || low ? '\uFFFD' : value.charAt(i);
    }
  }
  return out;
}

/** Keeps only RFC 3986 unreserved characters; encodeURIComponent alone leaves !'()* untouched. */
export function percentEncode(value: string): string {
  return encodeURIComponent(wellFormed(value)).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
