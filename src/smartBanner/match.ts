import type { BannerPlatform, SmartBannerConfig } from './types';

function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** `#/x` and `#!/x` are the page on hash-routed sites; a plain `#anchor` is not. */
export function currentRoute(loc: Pick<Location, 'pathname' | 'hash'>): string {
  return /^#!?(\/[^?#]*)/.exec(loc.hash)?.[1] ?? loc.pathname;
}

/** location.pathname is percent-encoded; dashboard patterns are typed decoded (`/café`). */
export function normalizePath(path: string): string {
  const lower = decodePath(path).toLowerCase();
  if (lower.length <= 1) return lower;
  return lower.replace(/\/+$/, '') || '/';
}

/** `*` matches any characters, including `/`. */
export function matchesPattern(pattern: string, path: string): boolean {
  const source = normalizePath(pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(normalizePath(path));
}

export function selectBanner(
  banners: SmartBannerConfig[],
  platform: BannerPlatform,
  pathname: string,
  isDismissed: (banner: SmartBannerConfig) => boolean,
): SmartBannerConfig | null {
  return (
    banners.find(
      (banner) =>
        banner.platforms.includes(platform) &&
        (banner.urlInclude.length === 0 ||
          banner.urlInclude.some((p) => matchesPattern(p, pathname))) &&
        !banner.urlExclude.some((p) => matchesPattern(p, pathname)) &&
        !isDismissed(banner),
    ) ?? null
  );
}
