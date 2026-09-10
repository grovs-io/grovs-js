import { describe, expect, it, vi } from 'vitest';
import { CookieStorage } from '../src/storage/cookie-storage';
import { ScreenAliases } from '../src/tracking/screen-aliases';
import { GrovsClient } from '../src/core/client';
import { LinkGenerator } from '../src/links/links';
import { MessagesService } from '../src/messages/messages';
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

describe('message responses are validated per entry', () => {
  it('drops malformed entries instead of crashing rendering', async () => {
    const { client, transport } = await authed();
    transport.enqueue({
      ok: true,
      status: 200,
      body: {
        notifications: [
          null,
          { id: 'x' },
          { id: 2, title: 'ok', subtitle: 's', read: false, access_url: 'u' },
        ],
      },
    });
    const messages = await new MessagesService(client).getMessages(1);
    expect(messages).toEqual([{ id: 2, title: 'ok', subtitle: 's', read: false, access_url: 'u' }]);
  });

  it('reports an automatic-display failure through onError', async () => {
    const { client, transport, onError } = await authed();
    transport.enqueueStatus(500);
    await new MessagesService(client).messagesForAutomaticDisplay();
    expect(onError).toHaveBeenCalledWith(GrovsError.networkRequestFailed, expect.any(String));
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

import { MessagesUI } from '../src/messages/messages-ui';
import { Logger } from '../src/logging/logger';

function deepActive(doc: Document): Element | null {
  let element = doc.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

describe('MessagesUI respects setEnabled(false)', () => {
  it('does not open the list while disabled', async () => {
    const { client } = await authed();
    client.setEnabled(false);
    await new MessagesUI(document, new MessagesService(client), new Logger()).showMessagesList();
    expect(document.getElementById('Grovs-modal')).toBeNull();
  });
});

describe('MessagesUI focus ownership', () => {
  const message = { id: 7, title: 'T', subtitle: '', read: false, access_url: 'https://x.com' };

  it('moves focus into a detail modal and restores it on close', async () => {
    const { client } = await authed();
    const launcher = document.createElement('button');
    document.body.appendChild(launcher);
    launcher.focus();

    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    ui.openPage(message);
    const modal = document.getElementById('Grovs-page-modal-7')!;
    expect(deepActive(document)).toBe(modal.shadowRoot!.querySelector('.grovs-close'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('Grovs-page-modal-7')).toBeNull();
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });

  it('close() with only automatic-display modals open restores focus', async () => {
    const { client } = await authed();
    const launcher = document.createElement('button');
    document.body.appendChild(launcher);
    launcher.focus();
    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    ui.openPage(message);
    ui.openPage({ ...message, id: 8 });
    ui.close();
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });

  it('a sentinel receiving focus hands it back into the card', async () => {
    const { client } = await authed();
    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    ui.openPage(message);
    const root = document.getElementById('Grovs-page-modal-7')!.shadowRoot!;
    const [start, end] = Array.from(root.querySelectorAll<HTMLElement>('.grovs-sentinel'));
    end!.focus();
    expect(deepActive(document)).toBe(root.querySelector('.grovs-close'));
    start!.focus();
    expect(deepActive(document)).toBe(root.querySelector('iframe'));
    ui.close();
  });

  it('brackets the list with sentinels that wrap focus', async () => {
    const { client, transport } = await authed();
    transport.enqueue({ ok: true, status: 200, body: { notifications: [message] } });
    transport.enqueue({ ok: true, status: 200, body: { number_of_unread_notifications: 1 } });
    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    await ui.showMessagesList();
    const root = document.getElementById('Grovs-modal')!.shadowRoot!;
    const close = root.querySelector<HTMLElement>('.grovs-close')!;
    const row = root.querySelector<HTMLElement>('.grovs-item')!;
    const [start, end] = Array.from(root.querySelectorAll<HTMLElement>('.grovs-sentinel'));

    // Sequential focus past the last row lands on the end sentinel.
    end!.focus();
    expect(deepActive(document)).toBe(close);
    start!.focus();
    expect(deepActive(document)).toBe(row);
    ui.close();
  });
});

describe('MessagesUI survives the host detaching its modals', () => {
  const message = { id: 11, title: 'T', subtitle: '', read: false, access_url: 'https://x.com' };

  it('stops trapping Tab once a modal is gone from the document', async () => {
    const { client } = await authed();
    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    ui.openPage(message);
    document.body.innerHTML = '';
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    ui.close();
  });

  it('renders the empty state without innerHTML', async () => {
    const { client, transport } = await authed();
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });
    transport.enqueue({ ok: true, status: 200, body: { number_of_unread_notifications: 0 } });
    const setter = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
    Object.defineProperty(Element.prototype, 'innerHTML', {
      ...setter,
      set() {
        throw new Error('Trusted Types');
      },
    });
    const ui = new MessagesUI(document, new MessagesService(client), new Logger());
    try {
      await ui.showMessagesList();
    } finally {
      Object.defineProperty(Element.prototype, 'innerHTML', setter);
    }
    const root = document.getElementById('Grovs-modal')!.shadowRoot!;
    expect(root.querySelector('.grovs-empty')?.textContent).toContain('No messages yet.');
    ui.close();
  });
});
