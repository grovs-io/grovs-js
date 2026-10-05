import { randomUUID } from '../core/uuid';
import type { Logger } from '../logging/logger';
import { BRIDGE } from './bridge.generated';
import type { Page } from './controller';
import { RESERVED_EVENT_NAMES } from './reserved-events.generated';

/**
 * One html message's page: a sandboxed srcdoc frame with bridge.js injected
 * before any author script, and the envelope the bridge posts back.
 *
 * Without allow-same-origin the page cannot reach the host page, its storage
 * or its cookies; it can only post messages, and only messages from this
 * frame's window carrying this show's token are read.
 */

const CONTROLS = /^[\x00-\x20]+|[\x00-\x20]+$/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const REFUSED: readonly string[] = ['javascript', 'vbscript', 'data', 'blob', 'file', 'about', 'intent', 'http'];
const DOCTYPE = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i;
const NAME_MAX = 100;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The shared link rule: the normalised link, or null when it is refused. */
export function allowedLink(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const url = input.replace(CONTROLS, '').replace(/[\t\n\r]/g, '');
  if (url.startsWith('#')) return url;
  const scheme = SCHEME.exec(url)?.[0].slice(0, -1).toLowerCase();
  if (scheme === undefined || REFUSED.includes(scheme)) return null;
  const link = scheme + url.slice(scheme.length);
  return scheme === 'https' && !/^https:\/\/[^/?#\t\n\v\f\r ]/.test(link) ? null : link;
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= NAME_MAX;
}

function isAttribute(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/** As JSON inside an inline script: no "</script>" can close it early. */
function literal(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** After the doctype, never before it; a page without one gets one, as quirks mode sizes it to its frame. */
function inject(html: string, token: string, page: Page): string {
  const boot =
    `window.__grovs={token:${literal(token)},user:${literal(page.user)},event:${literal(page.event)},` +
    `capabilities:${literal({ pushPermission: 'unsupported' })},` +
    // Bound now: author code may replace window.parent.
    'post:(function(){var p=parent;var pm=p.postMessage.bind(p);return function(m){pm(m,"*")}})()};';
  const script = `<script>${boot}${BRIDGE}</script>`;
  const doctype = DOCTYPE.exec(html)?.[0] ?? '';
  return (doctype || '<!doctype html>') + script + html.slice(doctype.length);
}

export interface FrameEvents {
  ready(): void;
  missing(): void;
  height(value: number): void;
  close(): void;
  /** `active` is false when the frame itself had no tap behind the call. */
  open(url: string, active: boolean): void;
  /** The page loaded a second time: it navigated itself. */
  navigated(): void;
}

export class HtmlFrame {
  readonly element: HTMLIFrameElement;
  /** Calls other than ready and height are taken only once the message is on screen. */
  shown = false;
  private readonly token = randomUUID();
  private loads = 0;
  private readonly win: Window | null;

  constructor(
    doc: Document,
    html: string,
    private readonly page: Page,
    private readonly events: FrameEvents,
    private readonly logger: Logger,
  ) {
    this.win = doc.defaultView;
    const frame = doc.createElement('iframe');
    frame.className = 'frame';
    frame.title = 'Message';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allow', 'autoplay; fullscreen');
    frame.srcdoc = inject(html, this.token, page);
    frame.addEventListener('load', this.onLoad);
    this.win?.addEventListener('message', this.onMessage);
    this.element = frame;
  }

  destroy(): void {
    this.element.removeEventListener('load', this.onLoad);
    this.win?.removeEventListener('message', this.onMessage);
  }

  private readonly onLoad = (): void => {
    this.loads += 1;
    if (this.loads > 1) this.events.navigated();
  };

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source === null || event.source !== this.element.contentWindow) return;
    const message: unknown = event.data;
    if (!isObject(message) || message.v !== 1 || message.token !== this.token) return;
    const { id, type, args } = message;
    if (typeof id !== 'string' || !isObject(args)) return;
    if (type === 'ready') {
      if (args.missing === true) this.events.missing();
      else if (args.missing === false) this.events.ready();
    } else if (type === 'height') {
      const { value } = args;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) this.events.height(value);
    } else if (type === 'requestPushPermission') {
      this.reply(this.shown ? { v: 1, id, ok: true, result: 'unsupported' } : { v: 1, id, ok: false, error: 'not_shown' });
    } else if (!this.shown) {
      this.logger.warn(`In-app page called ${String(type)} before it was shown; ignored`);
    } else {
      this.act(type, args);
    }
  };

  private act(type: unknown, args: Json): void {
    if (type === 'close') return this.events.close();
    if (type === 'open') {
      const url = allowedLink(args.url);
      if (url === null) return this.logger.warn(`In-app page link refused: ${String(args.url)}`);
      // bridge.js scrolls fragments itself; one reaching here has nothing to open.
      if (!url.startsWith('#')) this.events.open(url, args.active !== false);
      return;
    }
    if (type === 'track') {
      const { name, properties = {} } = args;
      if (!isName(name) || RESERVED_EVENT_NAMES.includes(name) || !isObject(properties)) {
        return this.logger.warn(`In-app page event refused: ${String(name)}`);
      }
      return this.page.actions.track(name, properties);
    }
    if (type === 'setAttribute') {
      const { key, value } = args;
      if (!isName(key) || !isAttribute(value)) return this.logger.warn(`In-app page attribute refused: ${String(key)}`);
      this.page.actions.setAttribute(key, value);
    }
  }

  private reply(message: Json): void {
    // An opaque origin: the frame's own window is the only one that can receive it.
    this.element.contentWindow?.postMessage(message, '*');
  }
}
