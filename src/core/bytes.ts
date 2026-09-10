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
