import type { Definition } from '../live-backend';

export const EVENT = 'zz_qa_evt';
export const onEvent = [{ type: 'event', name: EVENT }];

export const NATIVE_TEMPLATES = [
  'cover',
  'interstitial',
  'half_interstitial',
  'header',
  'footer',
  'alert',
  'cover_image',
  'interstitial_image',
  'half_interstitial_image',
] as const;

export const LAYOUTS = ['full', 'modal', 'banner_top', 'banner_bottom'] as const;

/** A native message with a title, a message and two buttons, shown on the host's trigger event. */
export function native(template: string, content: Record<string, unknown> = {}, rest: Definition = {}): Definition {
  return {
    template,
    priority: 10,
    triggers: onEvent,
    content: {
      title: `zz title ${template}`,
      message: `zz message ${template}`,
      buttons: [
        { id: 'ok', text: 'zz OK', action: { type: 'close' } },
        { id: 'kv', text: 'zz KV', action: { type: 'key_value', payload: { zz: template } } },
      ],
      ...content,
    },
    ...rest,
  };
}

/** A page that tells the bridge it is ready and has a height, as any page does once it loads. */
export function page(body: string, head = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body>${body}</body></html>`;
}

export function html(layout: string, body: string, content: Record<string, unknown> = {}, rest: Definition = {}): Definition {
  return {
    template: 'html',
    priority: 10,
    triggers: onEvent,
    content: { layout, html: body, ...content },
    ...rest,
  };
}

export function question(type: 'stars' | 'choice', template = 'interstitial'): Definition {
  const asked =
    type === 'stars'
      ? { id: 'q1', type: 'stars', options: [], comment: { split: null, low: 'zz why', high: null }, thanks: 'zz thanks', review_from: null }
      : {
          id: 'q1',
          type: 'choice',
          options: [
            { id: 'search', text: 'zz Search' },
            { id: 'friend', text: 'zz A friend' },
          ],
          comment: null,
          thanks: 'zz thanks',
          review_from: null,
        };
  return native(template, { title: `zz question ${type}`, message: null, buttons: [], question: asked });
}
