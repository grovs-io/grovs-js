import { parseBanners, type SmartBannerConfig } from '../../src/smartBanner/types';
import type { TransportRequest, TransportResponse } from '../../src/net/transport';
import { FakeTransport } from '../helpers/fake-transport';

export const RAW_BANNER = {
  id: 1,
  platforms: ['ios', 'android'],
  url_include: [],
  url_exclude: [],
  position: 'top',
  title: 'Get the app',
  subtitle: 'Faster checkout',
  button_text: 'Open',
  background_color: '#ffffff',
  text_color: '#111111',
  button_color: '#4f46e5',
  button_text_color: '#ffffff',
  icon_url: 'https://cdn.example.com/icon.png',
  dismiss_days: 7,
  default_link: 'https://go.example.com/default',
};

export function bannerConfig(overrides: Partial<SmartBannerConfig> = {}): SmartBannerConfig {
  return { ...parseBanners({ smart_banners: [RAW_BANNER] })[0]!, ...overrides };
}

/** Holds the next request to a URL suffix, so a response can arrive after something else happened. */
export class HoldingTransport extends FakeTransport {
  readonly holds = new Map<string, Promise<TransportResponse>>();

  override send(req: TransportRequest): Promise<TransportResponse> {
    for (const [suffix, held] of this.holds) {
      if (req.url.endsWith(suffix)) {
        this.holds.delete(suffix);
        this.requests.push(req);
        return held;
      }
    }
    return super.send(req);
  }
}

export function deferred() {
  let resolve!: (value: TransportResponse) => void;
  const promise = new Promise<TransportResponse>((r) => (resolve = r));
  return { promise, resolve };
}
