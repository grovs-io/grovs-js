/**
 * Which campaigns have their images on the device.
 *
 * A campaign is shown only once every image it names has loaded, so a message
 * never appears with a blank where its picture should be. The browser's own
 * cache holds the bytes; this only remembers which addresses have loaded.
 * Addresses carry a hash of their content, so a loaded address stays good.
 */

export type ImageLoader = (url: string) => Promise<boolean>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function imagesOf(campaign: unknown): string[] {
  if (!isObject(campaign) || !isObject(campaign.content) || !isObject(campaign.content.image)) return [];
  const { portrait, landscape } = campaign.content.image;
  return [portrait, landscape].filter((url): url is string => typeof url === 'string' && url.startsWith('https://'));
}

export class ImageCache {
  private readonly loaded = new Set<string>();
  private readonly loading = new Set<string>();

  constructor(private readonly loader: ImageLoader) {}

  /** Starts loading what is missing. Failures are retried by the next call, after the next sync. */
  preload(campaigns: readonly unknown[]): void {
    for (const url of campaigns.flatMap(imagesOf)) {
      if (this.loaded.has(url) || this.loading.has(url)) continue;
      this.loading.add(url);
      void this.loader(url)
        .then((ok) => {
          if (ok) this.loaded.add(url);
        })
        .catch(() => undefined)
        .then(() => {
          this.loading.delete(url);
        });
    }
  }

  ready(campaign: unknown): boolean {
    return imagesOf(campaign).every((url) => this.loaded.has(url));
  }
}
