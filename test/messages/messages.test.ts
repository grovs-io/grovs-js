import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagesService } from '../../src/messages/messages';
import { MessagesUI } from '../../src/messages/messages-ui';
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

  function makeUI(client: GrovsClient) {
    return new MessagesUI(document, new MessagesService(client), new Logger());
  }

  it('mounts a modal into the document', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });

    await makeUI(client).showMessagesList();
    expect(document.getElementById('Grovs-modal')).not.toBeNull();
  });

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
    expect(document.querySelectorAll('.grovs-item')).toHaveLength(2);
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
    expect(document.querySelector('.grovs-item img')).toBeNull();
    expect(document.querySelector('.grovs-item-title')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });

  // Defect nine: grovs_ui_helper.js:240 painted the overlay red one line after
  // setting the intended translucent black.
  it('renders a translucent backdrop, not red', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);

    makeUI(client).openPage({
      id: 1,
      title: 'T',
      subtitle: '',
      read: false,
      access_url: 'https://x.com',
    });

    const overlay = document.getElementById('Grovs-page-modal');
    expect(overlay?.style.backgroundColor).toBe('rgba(0, 0, 0, 0.5)');
    expect(overlay?.style.background).not.toContain('red');
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
    expect(document.getElementById('Grovs-modal')?.textContent).toContain('No messages yet');
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
