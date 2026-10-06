import type { BannerPlatform } from './types';

/** Banner-only UA check; core/environment.ts deliberately avoids sniffing. */
export function detectPlatform(userAgent: string, maxTouchPoints: number): BannerPlatform | null {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  // iPadOS Safari reports a desktop Mac UA; touch points tell them apart.
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return 'ios';
  if (/Android/.test(userAgent)) return 'android';
  return null;
}
