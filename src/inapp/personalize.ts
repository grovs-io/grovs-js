import { percentEncode, textOf } from './values';
import type { Campaign, EngineEvent, Rendered } from './types';

/**
 * Fills {{ user.key }} and {{ event.key }} fields, and judges links.
 *
 * Null from `render` means a field had no value and no fallback, or the text
 * opened braces that are not a field. Either way the campaign is not shown:
 * a user must never see raw braces.
 */

const FIELD = /\{\{\s*(user|event)\.([A-Za-z0-9_]+)\s*(?:\|\s*default:\s*"([^"]*)"\s*)?\}\}/g;
const FORBIDDEN: readonly string[] = ['javascript', 'data', 'file', 'blob'];
const AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export interface Sources {
  user: Record<string, unknown>;
  event: Record<string, unknown>;
}

export function fill(template: string, sources: Sources, encode = false): string | null {
  if (template.replace(FIELD, '').includes('{{')) return null;
  let missing = false;
  const filled = template.replace(FIELD, (_whole, source: string, key: string, fallback?: string) => {
    const from = source === 'user' ? sources.user : sources.event;
    let value = textOf(Object.prototype.hasOwnProperty.call(from, key) ? from[key] : undefined);
    if (value === null || value === '') value = fallback ?? null;
    if (value === null) {
      missing = true;
      return '';
    }
    return encode ? percentEncode(value) : value;
  });
  return missing ? null : filled;
}

export function links(campaign: Campaign): string[] {
  const actions = [...campaign.content.buttons.map((button) => button.action), campaign.content.tapAction];
  const out: string[] = [];
  for (const action of actions) {
    if (action && action.type === 'open_url' && action.url !== undefined) out.push(action.url);
  }
  return out;
}

/** The scheme and host are judged on the template, so a filled value can never supply either. */
export function unsafe(template: string, filled: string): boolean {
  const fixed = AUTHORITY.exec(template)?.[0] ?? SCHEME.exec(template)?.[0];
  if (fixed === undefined || fixed.includes('{{')) return true;
  const scheme = /^[^:]+/.exec(filled)?.[0] ?? '';
  return FORBIDDEN.includes(scheme.toLowerCase());
}

export type Outcome = { rendered: Rendered } | { reason: 'personalization' | 'unsafe_link' };

export function render(campaign: Campaign, event: EngineEvent, user: Record<string, unknown>): Outcome {
  const sources: Sources = { user, event: event.properties ?? {} };
  const { content } = campaign;
  const title = content.title === null ? null : fill(content.title, sources);
  const message = content.message === null ? null : fill(content.message, sources);
  const buttons = content.buttons.map((button) => fill(button.text, sources));
  const templates = links(campaign);
  const urls = templates.map((url) => fill(url, sources, true));

  const failed =
    (content.title !== null && title === null) ||
    (content.message !== null && message === null) ||
    buttons.includes(null) ||
    urls.includes(null);
  if (failed) return { reason: 'personalization' };

  const filled = urls as string[];
  if (templates.some((template, index) => unsafe(template, filled[index] ?? ''))) return { reason: 'unsafe_link' };
  return { rendered: { title, message, buttons: buttons as string[], urls: filled } };
}
