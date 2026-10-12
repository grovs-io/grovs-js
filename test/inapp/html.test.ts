import { describe, expect, it } from 'vitest';
import { readCampaign } from '../../src/inapp/definition';
import { allowedLink } from '../../src/inapp/htmlFrame';
import { merge, readJson } from './shared';

type Json = Record<string, unknown>;

const CASES = readJson('cases.json') as Json;
const BASE = CASES.base_campaign as Json;
const HTML = merge(BASE, { template: 'html', content: { html: '<p>Hi</p>', layout: 'modal' } });

describe('html template', () => {
  for (const kase of CASES.html_parsing as { name: string; content: Json; expect: string }[]) {
    it(kase.name, () => {
      const raw = merge(BASE, { template: 'html' });
      raw.content = { ...(raw.content as Json), ...kase.content };
      const campaign = readCampaign(raw);
      expect(campaign === null ? 'unsupported' : 'valid').toBe(kase.expect);
    });
  }

  it('reads the layout', () => {
    expect(readCampaign(HTML)?.content.layout).toBe('modal');
    expect(readCampaign(merge(HTML, { content: { layout: 'full' } }))?.content.layout).toBe('full');
  });

  it('reads the orientation on a page too, absent and any being null', () => {
    expect(readCampaign(merge(HTML, { content: { orientation: 'landscape' } }))?.content.orientation).toBe('landscape');
    expect(readCampaign(merge(HTML, { content: { orientation: 'any' } }))?.content.orientation).toBeNull();
    expect(readCampaign(HTML)?.content.orientation).toBeNull();
    expect(readCampaign(merge(HTML, { content: { orientation: 'sideways' } }))).toBeNull();
  });

  it('keeps the layout of other templates null', () => {
    expect(readCampaign(BASE)?.content.layout).toBeNull();
  });

  it('needs no title, message or buttons, and a dismissible: false page is still closable by the SDK', () => {
    const campaign = readCampaign(merge(HTML, { content: { title: null, message: null, dismissible: false } }));
    expect(campaign?.template).toBe('html');
  });
});

describe('link rule', () => {
  for (const kase of CASES.link_rule as { name: string; input: string; expect: string }[]) {
    it(kase.name, () => {
      expect(allowedLink(kase.input) === null ? 'refused' : 'allowed').toBe(kase.expect);
    });
  }

  it('returns the link normalised', () => {
    expect(allowedLink(' HTTPS://acme.example/a\tb ')).toBe('https://acme.example/ab');
    expect(allowedLink('MyApp://x')).toBe('myapp://x');
  });

  it('refuses what is not a string', () => {
    expect(allowedLink(undefined)).toBeNull();
    expect(allowedLink(42)).toBeNull();
  });
});
