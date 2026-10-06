import { getDocument, getNavigator, getWindow } from '../core/environment';
import type { Logger } from '../logging/logger';
import type { ApiService } from '../net/api';
import type { TransportResponse } from '../net/transport';
import { NavigationObserver } from '../tracking/navigation';
import { buildPayload, type LinkPayload, type SmartBannerLinkData } from './link-data';
import { currentRoute, selectBanner } from './match';
import { detectPlatform } from './platform';
import { FAIL_BACKOFF_MS, LINK_CAP, LIST_TTL_MS, type BannerStore } from './store';
import { isHttpUrl, parseBanners, type BannerPlatform, type SmartBannerConfig } from './types';
import { BannerView, HOST_ID } from './view';

export interface SmartBannerDeps {
  api: ApiService;
  logger: Logger;
  store: BannerStore;
  track: (name: string, properties: Record<string, unknown>) => void;
  /** The client's lifecycle generation: moves on configure(), reset(), setEnabled(false). */
  generation: () => number;
}

const MAX_HOLD_MS = 60 * 60 * 1000;

/** Worth backing off for; a 4xx will not get better by waiting. */
function transient(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

function currentPath(): string {
  const win = getWindow();
  return win ? currentRoute(win.location) : '/';
}

/** Field order is fixed by parseBanners, so the JSON forms compare reliably. */
function sameBanner(a: SmartBannerConfig | null, b: SmartBannerConfig | null): boolean {
  return a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));
}

export class SmartBannerController {
  private running = false;
  private platform: BannerPlatform | null = null;
  private view: BannerView | null = null;
  private linkData: SmartBannerLinkData | null = null;
  private linkDataPath: string | null = null;
  private route: string | null = null;
  private navCount = 0;
  private dataRev = 0;
  /** hide() holds for this route, across stop/start (re-configure, auth retry, consent). */
  private hiddenPath: string | null = null;
  private readonly viewedAt = new Map<number, number>();
  private readonly inflight = new Map<string, Promise<TransportResponse>>();
  // In-memory fallbacks for when sessionStorage is unavailable.
  private listRequest: { generation: number; promise: Promise<SmartBannerConfig[] | null> } | null = null;
  private memList: { at: number; banners: SmartBannerConfig[] } | null = null;
  private failedAt = -Infinity;
  private holdUntil = 0;
  private readonly memLinks = new Map<string, string>();
  /** Test seam: the latest evaluation. Never rejects. */
  settled: Promise<void> = Promise.resolve();
  private readonly navigation = new NavigationObserver('smartBanner', {
    immediate: () => this.onNavigate(),
    settled: () => {
      this.settled = this.evaluate();
    },
  });

  constructor(private readonly deps: SmartBannerDeps) {}

  start(): void {
    // setEnabled(true) can race a re-run configure(): the evaluation in flight belongs to the old generation.
    if (this.running) {
      void this.refresh();
      return;
    }
    const nav = getNavigator();
    this.platform = nav ? detectPlatform(nav.userAgent, nav.maxTouchPoints ?? 0) : null;
    if (!this.platform || !getDocument()) return;
    this.running = true;
    this.route = currentPath();
    if (this.linkDataPath !== this.route) this.linkData = null;
    this.navigation.start();
  }

  stop(): void {
    this.running = false;
    this.navigation.stop();
    this.navCount += 1;
    this.dataRev += 1;
    this.inflight.clear();
    this.forget();
    this.deps.store.clearPageView();
    this.removeView();
  }

  setLinkData(input: SmartBannerLinkData): void {
    try {
      if (!input || typeof input !== 'object') {
        this.deps.logger.warn('smartBanner.setLinkData() expects an object; ignored.');
        return;
      }
      this.linkData = input;
      this.linkDataPath = currentPath();
      this.dataRev += 1;
      if (this.view) {
        this.view.setHref(this.view.banner.defaultLink);
        void this.requestLink(this.view);
      }
    } catch (error) {
      this.fail('setLinkData', error);
    }
  }

  hide(): void {
    this.hiddenPath = currentPath();
    this.removeView();
  }

  refresh(): Promise<void> {
    this.settled = this.evaluate();
    return this.settled;
  }

  /** reset(): the page's link data may describe the visitor being cleared. */
  clearCaches(): void {
    this.deps.store.clearSession();
    this.forget();
    this.linkData = null;
    this.dataRev += 1;
  }

  private forget(): void {
    this.listRequest = null;
    this.memList = null;
    this.failedAt = -Infinity;
    this.holdUntil = 0;
    this.memLinks.clear();
  }

  private backingOff(): boolean {
    const now = Date.now();
    return now - this.failedAt < FAIL_BACKOFF_MS || now < this.holdUntil || this.deps.store.backingOff();
  }

  private noteResult(ok: boolean, retryAfter = 0): void {
    const retryAfterMs = Math.min(retryAfter, MAX_HOLD_MS);
    this.failedAt = ok ? -Infinity : Date.now();
    if (retryAfterMs > FAIL_BACKOFF_MS) this.holdUntil = Date.now() + retryAfterMs;
    this.deps.store.noteFailure(!ok, retryAfterMs);
  }

  /** A temporary failure keeps serving the last good list, so a showing banner stays. */
  private lastGood(): SmartBannerConfig[] {
    return this.memList?.banners ?? this.deps.store.cachedBanners(true) ?? [];
  }

  private onNavigate(): void {
    const path = currentPath();
    // A query or plain-anchor change is the same page: keep its link data.
    if (path === this.route) return;
    this.route = path;
    this.navCount += 1;
    // Set synchronously for the new route before its event arrived (location.hash = …; setLinkData()).
    if (this.hiddenPath !== path) this.hiddenPath = null;
    if (this.linkDataPath !== path) this.linkData = null;
    this.deps.store.clearPageView();
    if (this.view) this.view.setHref(this.view.banner.defaultLink);
  }

  private pageToken(): string {
    return `${this.deps.generation()}:${this.navCount}`;
  }

  private linkToken(): string {
    return `${this.pageToken()}:${this.dataRev}`;
  }

  private async evaluate(): Promise<void> {
    try {
      await this.select();
    } catch (error) {
      this.fail('evaluate', error);
    }
  }

  private async select(): Promise<void> {
    if (!this.running || !this.platform) return;
    const token = this.pageToken();
    const banners = await this.loadBanners();
    if (!banners || !this.running || token !== this.pageToken()) return;

    const doc = getDocument();
    if (!doc?.body) return;

    const pick =
      this.hiddenPath === currentPath()
        ? null
        : selectBanner(banners, this.platform, currentPath(), (b) => this.deps.store.isDismissed(b));

    // A Turbo/Hotwire/pjax body swap can remove the host without going through removeView(),
    // leaving the CSS-variable gap set for a banner that no longer exists.
    if (this.view && !this.view.isConnected()) this.removeView();

    if (!sameBanner(pick, this.view?.banner ?? null)) {
      this.removeView();
      if (pick && !this.show(doc, pick)) return;
    }
    const view = this.view;
    if (!view) return;

    if (this.viewedAt.get(view.banner.id) !== this.navCount) {
      this.viewedAt.set(view.banner.id, this.navCount);
      this.deps.track('smart_banner_view', { smart_banner_id: view.banner.id });
    }
    await this.requestLink(view);
  }

  private show(doc: Document, banner: SmartBannerConfig): boolean {
    if (doc.getElementById(HOST_ID)) {
      this.deps.logger.info('A smart banner is already on the page (another SDK copy?); not drawing a second.');
      return false;
    }
    const view = new BannerView(doc, banner, {
      // Store write is synchronous and never calls preventDefault, so the tap still navigates.
      onClick: () => {
        this.deps.store.dismiss(banner.id, banner.openHideDays);
        this.deps.track('smart_banner_click', { smart_banner_id: banner.id });
        // After the anchor's navigation has started, so returning to the tab shows no banner.
        setTimeout(() => {
          if (this.view === view) this.removeView();
        }, 0);
      },
      onClose: () => {
        this.deps.store.dismiss(banner.id, banner.dismissDays);
        this.deps.track('smart_banner_dismiss', { smart_banner_id: banner.id });
        this.removeView();
      },
    });
    view.mount();
    this.view = view;
    return true;
  }

  private removeView(): void {
    this.view?.remove();
    this.view = null;
  }

  /** Null when the lifecycle moved on while the list was in flight. */
  private async loadBanners(): Promise<SmartBannerConfig[] | null> {
    const cached = this.deps.store.cachedBanners();
    if (cached) return cached;
    const now = Date.now();
    if (this.memList && now - this.memList.at <= LIST_TTL_MS) return this.memList.banners;
    if (this.backingOff()) return this.lastGood();
    const generation = this.deps.generation();
    if (this.listRequest?.generation !== generation) {
      const entry = { generation, promise: this.fetchBanners(generation) };
      this.listRequest = entry;
      const clear = (): void => {
        if (this.listRequest === entry) this.listRequest = null;
      };
      entry.promise.then(clear, clear);
    }
    return this.listRequest.promise;
  }

  private async fetchBanners(generation: number): Promise<SmartBannerConfig[] | null> {
    let response: TransportResponse;
    try {
      response = await this.deps.api.smartBanners();
    } catch (error) {
      if (this.running && generation === this.deps.generation()) this.noteResult(false);
      throw error;
    }
    // Checked before caching: reset() may have wiped storage while this was in flight.
    if (!this.running || generation !== this.deps.generation()) return null;
    if (!response.ok) {
      this.deps.logger.info(`Smart banners unavailable (HTTP ${response.status}).`);
      if (transient(response.status)) {
        this.noteResult(false, response.retryAfterMs);
        return this.lastGood();
      }
    }
    // A 4xx will not change on retry: no banners until the list TTL.
    const body = response.ok ? response.body : {};
    this.deps.store.cacheBanners(body);
    if (response.ok) this.noteResult(true);
    const banners = parseBanners(body);
    this.memList = { at: Date.now(), banners };
    return banners;
  }

  private async requestLink(view: BannerView): Promise<void> {
    try {
      // Without page data the banner keeps its default link.
      if (!this.linkData) return;
      const payload = buildPayload(this.linkData, currentPath());
      if (!payload) {
        this.deps.logger.warn('Smart banner link data breaks the limits; using the default link.');
        return;
      }
      const id = view.banner.id;
      const memKey = `${id}:${payload.key}`;
      const cached = this.deps.store.cachedLink(id, payload.key) ?? this.memLinks.get(memKey);
      if (cached) {
        view.setHref(cached);
        return;
      }

      if (this.backingOff()) return;

      const token = this.linkToken();
      const generation = this.deps.generation();
      const response = await this.fetchLink(id, payload).catch(() => null);
      if (!this.running || generation !== this.deps.generation()) return;

      const link = (response?.body as { link?: unknown } | null | undefined)?.link;
      const good = response?.ok === true && isHttpUrl(link);
      if (!good) {
        this.deps.logger.info(`Smart banner link unavailable (HTTP ${response?.status ?? 0}); using the default link.`);
        if (!response || transient(response.status)) {
          this.noteResult(false, response?.retryAfterMs);
          return;
        }
        if (response.ok) return;
      }
      // A 4xx will not change on retry: remember the default link for this data.
      const href = good ? link : view.banner.defaultLink;
      this.deps.store.cacheLink(id, payload.key, href);
      if (good) this.noteResult(true);
      this.memLinks.delete(memKey);
      this.memLinks.set(memKey, href);
      if (this.memLinks.size > LINK_CAP) this.memLinks.delete(this.memLinks.keys().next().value!);
      if (token === this.linkToken() && this.view === view) view.setHref(href);
    } catch (error) {
      this.fail('link', error);
    }
  }

  /** setLinkData and the next frame's selection usually ask for the same link together. */
  private fetchLink(id: number, payload: LinkPayload): Promise<TransportResponse> {
    const key = `${id}:${payload.key}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const request = this.deps.api.smartBannerLink(id, payload.body);
    this.inflight.set(key, request);
    const clear = (): void => {
      if (this.inflight.get(key) === request) this.inflight.delete(key);
    };
    request.then(clear, clear);
    return request;
  }

  private fail(where: string, error: unknown): void {
    this.deps.logger.warn(
      `Smart banner ${where} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
