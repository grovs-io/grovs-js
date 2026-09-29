import { describe, expect, it, vi } from 'vitest';
import { CookieStorage } from '../src/storage/cookie-storage';
import { ScreenAliases } from '../src/tracking/screen-aliases';
import { GrovsClient } from '../src/core/client';
import { LinkGenerator } from '../src/links/links';
import { GrovsError } from '../src/net/errors';
import { FakeTransport } from './helpers/fake-transport';
import { FakeStorage } from './helpers/fake-storage';
import type { QueuedEvent } from '../src/events/event';

const AUTH_OK = {
  ok: true,
  status: 200,
  body: { linksquared: 'v1', sdk_identifier: null, sdk_attributes: null },
};

async function authed(onError = vi.fn()) {
  const transport = new FakeTransport();
  const storage = new FakeStorage();
  transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
  const client = new GrovsClient(
    { apiKey: 'k', onError },
    { transport, storage, autoStartEvents: false },
  );
  await client.configure();
  return { client, transport, storage, onError };
}

describe('CookieStorage tolerates a malformed cookie', () => {
  it('treats an undecodable value as absent rather than throwing', () => {
    document.cookie = 'linksquared=%';
    const store = new CookieStorage(document);
    expect(store.get('linksquared')).toBeNull();
    document.cookie = 'linksquared=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
  });

  it('does not stop the client constructing over its real identity store', () => {
    document.cookie = 'linksquared=%';
    localStorage.setItem('linksquared', 'from-mirror');
    const client = new GrovsClient({ apiKey: 'k' }, { transport: new FakeTransport() });
    expect(client['context'].linksquaredId).toBe('from-mirror');
    client.dispose();
    localStorage.clear();
    document.cookie = 'linksquared=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
  });
});

describe('screen names are bounded', () => {
  it('a 9000-character screen name does not contaminate later events', async () => {
    const { client, storage } = await authed();
    client.trackScreenView('x'.repeat(9000));
    client.track('tap');
    client.shutdown();
    const queued = JSON.parse(storage.get('grovs_events') ?? '[]') as QueuedEvent[];
    expect(queued).toHaveLength(2);
    for (const event of queued) {
      const encoded = JSON.stringify(event.properties ?? {});
      expect(encoded.length).toBeLessThanOrEqual(8192);
      expect((event.properties?.['screen_name'] as string).length).toBe(255);
    }
  });
});

describe('generateLink keeps its failure contract', () => {
  it('resolves null and reports linkGenerationFailed for unserializable data', async () => {
    const { client, onError } = await authed();
    const links = new LinkGenerator(client);
    await expect(links.generateLink({ data: { counter: 1n } })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(GrovsError.linkGenerationFailed, expect.any(String));
  });
});

describe('alias precedence is independent of insertion order', () => {
  it('a parameter pattern beats a wildcard pattern', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/product/*': 'Catalogue', '/product/:id': 'Product' });
    expect(aliases.resolve('/product/42')).toBe('Product');
    aliases.set({ '/product/:id': 'Product', '/product/*': 'Catalogue' });
    expect(aliases.resolve('/product/42')).toBe('Product');
  });

  it('more literal text wins among equal wildcards', () => {
    const aliases = new ScreenAliases();
    aliases.set({ '/:section': 'Section', '/docs/:page': 'Docs' });
    expect(aliases.resolve('/docs/intro')).toBe('Docs');
  });
});
