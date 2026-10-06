export type BannerPlatform = 'ios' | 'android';

export interface SmartBannerConfig {
  id: number;
  platforms: BannerPlatform[];
  urlInclude: string[];
  urlExclude: string[];
  position: 'top' | 'bottom';
  title: string;
  subtitle: string | null;
  buttonText: string;
  backgroundColor: string;
  textColor: string;
  buttonColor: string;
  buttonTextColor: string;
  iconUrl: string | null;
  dismissDays: number;
  openHideDays: number;
  defaultLink: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_OPEN_HIDE_DAYS = 30;

/** Older backends never send this field; an invalid value falls back rather than dropping the banner. */
function parseOpenHideDays(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 365
    ? value
    : DEFAULT_OPEN_HIDE_DAYS;
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : null;
}

/** Drops entries that break the contract instead of failing the whole list. */
export function parseBanners(body: unknown): SmartBannerConfig[] {
  const list = (body as { smart_banners?: unknown } | null)?.smart_banners;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const banner = parseBanner(raw);
    return banner ? [banner] : [];
  });
}

function parseBanner(raw: unknown): SmartBannerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const platforms = strings(r['platforms'])?.filter(
    (p): p is BannerPlatform => p === 'ios' || p === 'android',
  );
  const urlInclude = strings(r['url_include']);
  const urlExclude = strings(r['url_exclude']);
  const colors = [r['background_color'], r['text_color'], r['button_color'], r['button_text_color']];
  const position = r['position'];

  if (
    typeof r['id'] !== 'number' ||
    !platforms?.length ||
    !urlInclude ||
    !urlExclude ||
    (position !== 'top' && position !== 'bottom') ||
    typeof r['title'] !== 'string' ||
    typeof r['button_text'] !== 'string' ||
    !colors.every((c) => typeof c === 'string' && HEX.test(c)) ||
    typeof r['dismiss_days'] !== 'number' ||
    !isHttpUrl(r['default_link'])
  ) {
    return null;
  }

  return {
    id: r['id'],
    platforms,
    urlInclude,
    urlExclude,
    position,
    title: r['title'],
    subtitle: typeof r['subtitle'] === 'string' ? r['subtitle'] : null,
    buttonText: r['button_text'],
    backgroundColor: colors[0] as string,
    textColor: colors[1] as string,
    buttonColor: colors[2] as string,
    buttonTextColor: colors[3] as string,
    iconUrl: isHttpUrl(r['icon_url']) ? r['icon_url'] : null,
    dismissDays: r['dismiss_days'],
    openHideDays: parseOpenHideDays(r['open_hide_days']),
    defaultLink: r['default_link'],
  };
}
