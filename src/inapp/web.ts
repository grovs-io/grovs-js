import { getDocument, getNavigator, getWindow } from '../core/environment';
import type { Logger } from '../logging/logger';
import type { Answered, Commented, Outcome, Presentation, Presenter } from './controller';
import { InAppRenderer } from './renderer';
import type { Device } from './types';

/**
 * What the browser supplies to the in-app engine. Everything that names a
 * browser global goes through core/environment, so the SDK stays inert
 * during server rendering.
 */

/** Web push does not exist yet, and a web page has no store to rate it in or to be updated from. */
const UNSUPPORTED_ACTIONS: readonly string[] = ['request_push_permission', 'request_app_rating', 'open_store'];

/** The primary language only, in lowercase: `en` for `en-US`. Every platform reports it this way. */
export function primaryLanguage(tag: string | undefined): string {
  return (tag ?? '').split(/[-_]/)[0]?.toLowerCase() ?? '';
}

export function webDevice(appVersion: string, user: Record<string, unknown> | null): Omit<Device, 'firstSeenAt'> {
  return {
    platform: 'web',
    appVersion,
    osVersion: '',
    language: primaryLanguage(getNavigator()?.language),
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    user: user ?? {},
    pushPermission: 'not_asked',
    orientation: portrait() ? 'portrait' : 'landscape',
    unsupportedTemplates: [],
    unsupportedActions: UNSUPPORTED_ACTIONS,
  };
}

/** Desktop browsers are usually landscape; without matchMedia, portrait. */
export function portrait(): boolean {
  return getWindow()?.matchMedia?.('(orientation: portrait)').matches !== false;
}

export function loadImage(url: string): Promise<boolean> {
  const doc = getDocument();
  if (!doc) return Promise.resolve(false);
  return new Promise((resolve) => {
    const image = doc.createElement('img');
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  });
}

export function isVisible(): boolean {
  return getDocument()?.visibilityState !== 'hidden';
}

/** Builds the renderer on first use: a page that never shows a message never touches the DOM for one. */
export class WebPresenter implements Presenter {
  private renderer: InAppRenderer | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly leaving: () => void,
  ) {}

  present(presentation: Presentation, drawn: () => void, answered: Answered, commented: Commented): Promise<Outcome> {
    const doc = getDocument();
    if (!doc) return Promise.reject(new Error('no document'));
    // Next task: the click is reported first; then send the queue, as WebKit may fire no pagehide on the way out.
    this.renderer ??= new InAppRenderer(doc, this.logger, (url) =>
      setTimeout(() => {
        this.leaving();
        try {
          getWindow()?.location.assign(url);
        } catch (error) {
          this.logger.warn(`In-app link could not be opened: ${String(error)}`);
        }
      }),
    );
    return this.renderer.present(presentation, drawn, answered, commented);
  }

  lost(): boolean {
    return this.renderer?.lost() ?? false;
  }

  dismiss(): void {
    this.renderer?.dismiss();
  }
}
