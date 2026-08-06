import { getCrypto } from './environment';

/**
 * A v4 UUID, used for session ids and for event_id.
 *
 * event_id is minted once at enqueue and must survive every retry for the
 * planned server-side dedup to work (spec A4/B11), so this needs to be
 * collision-free in practice rather than merely unique-looking.
 *
 * crypto.randomUUID is unavailable on http:// origins and in older browsers,
 * so there is a fallback — but it prefers getRandomValues over Math.random,
 * which has far too little entropy for an id the backend will dedup on.
 */
export function randomUUID(): string {
  const crypto = getCrypto();

  if (crypto?.randomUUID) return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }

  // Set the version (4) and variant (RFC 4122) bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) hex.push((bytes[i] ?? 0).toString(16).padStart(2, '0'));

  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}
