import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagesService } from '../../src/messages/messages';
import { MessagesUI } from '../../src/messages/messages-ui';
import type { MessagesTheme } from '../../src/messages/messages-theme';
import { GrovsClient } from '../../src/core/client';
import { Logger } from '../../src/logging/logger';
import { FakeTransport } from '../helpers/fake-transport';
import { FakeStorage } from '../helpers/fake-storage';

const AUTH_OK = {
  ok: true,
  status: 200,
  body: { linksquared: 'v1', sdk_identifier: null, sdk_attributes: null },
};

async function authedClient(transport: FakeTransport) {
  transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
  const client = new GrovsClient({ apiKey: 'k' }, { transport, storage: new FakeStorage() });
  await client.configure();
  return client;
}

describe('MessagesService', () => {
  it('returns the notifications array', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({
      ok: true,
      status: 200,
      body: { notifications: [{ id: 1, title: 'A', subtitle: 'B', read: false, access_url: 'u' }] },
    });

    const messages = await new MessagesService(client).getMessages(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.title).toBe('A');
  });

  it('returns an empty array on failure rather than throwing', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueueStatus(500);
    await expect(new MessagesService(client).getMessages(1)).resolves.toEqual([]);
  });

  it('returns the unread count', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { number_of_unread_notifications: 7 } });
    await expect(new MessagesService(client).numberOfUnreadMessages()).resolves.toBe(7);
  });

  it('returns 0 for the unread count on failure', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueueStatus(500);
    await expect(new MessagesService(client).numberOfUnreadMessages()).resolves.toBe(0);
  });

  it('reports success when marking read', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: {} });
    await expect(new MessagesService(client).markMessageAsRead(3)).resolves.toBe(true);
    expect(transport.last?.body).toEqual({ id: 3 });
  });

  it('reports failure when marking read fails', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueueStatus(500);
    await expect(new MessagesService(client).markMessageAsRead(3)).resolves.toBe(false);
  });

  // v1 implemented this and commented out the body (grovs_manager.js:229-242).
  it('returns automatic-display messages', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({
      ok: true,
      status: 200,
      body: { notifications: [{ id: 9, title: 'Auto', subtitle: '', read: false, access_url: 'u' }] },
    });
    const messages = await new MessagesService(client).messagesForAutomaticDisplay();
    expect(messages).toHaveLength(1);
  });

  it('returns an empty array when automatic display fails', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueueStatus(500);
    await expect(new MessagesService(client).messagesForAutomaticDisplay()).resolves.toEqual([]);
  });

  it('tolerates a response with no notifications key', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: {} });
    await expect(new MessagesService(client).getMessages(1)).resolves.toEqual([]);
  });
});

describe('MessagesUI', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function makeUI(client: GrovsClient, theme?: MessagesTheme) {
    return new MessagesUI(document, new MessagesService(client), new Logger(), theme);
  }

  it('mounts a modal into the document', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });

    await makeUI(client).showMessagesList();
    expect(document.getElementById('Grovs-modal')).not.toBeNull();
  });

  /** The modal lives in a shadow root, so host-document queries cannot see it. */
  function shadow(): ShadowRoot | null {
    return document.getElementById('Grovs-modal')?.shadowRoot ?? null;
  }

  it('renders one row per message', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({
      ok: true,
      status: 200,
      body: {
        notifications: [
          { id: 1, title: 'A', subtitle: 'x', read: false, access_url: 'u1' },
          { id: 2, title: 'B', subtitle: 'y', read: true, access_url: 'u2' },
        ],
      },
    });

    await makeUI(client).showMessagesList();
    expect(shadow()?.querySelectorAll('.grovs-item')).toHaveLength(2);
  });

  it('escapes message text rather than injecting it as HTML', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({
      ok: true,
      status: 200,
      body: {
        notifications: [
          { id: 1, title: '<img src=x onerror=alert(1)>', subtitle: '', read: false, access_url: 'u' },
        ],
      },
    });

    await makeUI(client).showMessagesList();
    expect(shadow()?.querySelector('.grovs-item img')).toBeNull();
    expect(shadow()?.querySelector('.grovs-item-title')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });

  // Defect nine's descendant: v1 painted the overlay red one line after
  // setting the intended translucent black. Styling now lives in a shadow
  // stylesheet driven by tokens, so the pin moves there.
  it('themes via a stylesheet, not a red debug background', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });

    await makeUI(client).showMessagesList();
    const root = shadow()!;
    const css = root.querySelector('style')!.textContent!;
    expect(css).toContain('--grovs-backdrop');
    // "red" alone would trip on "prefers-reduced-motion"; the v1 defect was a
    // literal red background.
    expect(css).not.toMatch(/background:\s*red/);
    expect(root.querySelector('.grovs-backdrop')).not.toBeNull();
    expect(root.querySelector('.grovs-card')).not.toBeNull();
  });

  it('shows the unread count in the header badge', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({
      ok: true,
      status: 200,
      body: {
        notifications: [
          { id: 1, title: 'a', subtitle: '', read: false, access_url: 'https://x.com' },
          { id: 2, title: 'b', subtitle: '', read: true, access_url: 'https://x.com' },
          { id: 3, title: 'c', subtitle: '', read: false, access_url: 'https://x.com' },
        ],
      },
    });

    await makeUI(client).showMessagesList();
    const badge = shadow()!.querySelector('.grovs-badge')!;
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('data-count')).toBe('2');
  });

  it('marks the row read and decrements the badge when a message opens', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({
      ok: true,
      status: 200,
      body: {
        notifications: [
          { id: 1, title: 'a', subtitle: '', read: false, access_url: 'https://x.com' },
        ],
      },
    });

    await makeUI(client).showMessagesList();
    (shadow()!.querySelector('.grovs-item') as HTMLElement).click();
    expect(shadow()!.querySelector('.grovs-item')!.getAttribute('data-read')).toBe('true');
    expect(shadow()!.querySelector('.grovs-badge')!.getAttribute('data-count')).toBe('0');
  });

  it('applies forced mode and position as host data attributes', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });

    await makeUI(client, { mode: 'dark', position: 'right' }).showMessagesList();
    const host = document.getElementById('Grovs-modal')!;
    expect(host.getAttribute('data-grovs-mode')).toBe('dark');
    expect(host.getAttribute('data-grovs-position')).toBe('right');
    const css = host.shadowRoot!.querySelector('style')!.textContent!;
    expect(css).toContain(':host([data-grovs-mode="dark"])');
  });

  it('removes the modal on close', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });

    const ui = makeUI(client);
    await ui.showMessagesList();
    ui.close();
    expect(document.getElementById('Grovs-modal')).toBeNull();
  });

  it('shows an empty state when there are no messages', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });

    await makeUI(client).showMessagesList();
    expect(shadow()?.textContent).toContain('No messages yet');
  });

  it('does not mount a second modal when already open', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });

    const ui = makeUI(client);
    await ui.showMessagesList();
    await ui.showMessagesList();
    expect(document.querySelectorAll('#Grovs-modal')).toHaveLength(1);
  });

  // Automatic display can open several pages at once; a shared id would put
  // duplicate ids in the customer's DOM and break getElementById for all but
  // the first.
  it('gives concurrently open page modals distinct ids', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);

    const ui = makeUI(client);
    ui.openPage({ id: 1, title: 'A', subtitle: '', read: false, access_url: 'https://x.com' });
    ui.openPage({ id: 2, title: 'B', subtitle: '', read: false, access_url: 'https://x.com' });

    const modals = Array.from(document.querySelectorAll('.grovs-page-modal'));
    expect(modals).toHaveLength(2);
    const ids = modals.map((modal) => modal.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('does not open the same message twice', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);

    const ui = makeUI(client);
    const message = { id: 1, title: 'A', subtitle: '', read: false, access_url: 'https://x.com' };
    ui.openPage(message);
    ui.openPage(message);

    expect(document.querySelectorAll('.grovs-page-modal')).toHaveLength(1);
  });

  it('marks a message read when its page is opened', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.requests.length = 0;

    makeUI(client).openPage({
      id: 42,
      title: 'T',
      subtitle: '',
      read: false,
      access_url: 'https://x.com',
    });

    await vi.waitFor(() =>
      expect(transport.requestsTo('/mark_notification_as_read')).toHaveLength(1),
    );
    expect(transport.last?.body).toEqual({ id: 42 });
  });
});
