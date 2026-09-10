import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagesService, type GrovsMessage } from '../../src/messages/messages';
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

  // v1 once painted the overlay debug-red; the pin moved into the stylesheet.
  it('themes via a stylesheet, not a red debug background', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });

    await makeUI(client).showMessagesList();
    const root = shadow()!;
    const css = root.querySelector('style')!.textContent!;
    expect(css).toContain('--grovs-backdrop');
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

    // The count is server-sourced, not derived from the rendered pages.
    transport.enqueue({ ok: true, status: 200, body: { number_of_unread_notifications: 12 } });

    await makeUI(client).showMessagesList();
    const badge = shadow()!.querySelector('.grovs-badge')!;
    expect(badge.textContent).toBe('12');
    expect(badge.getAttribute('data-count')).toBe('12');
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
    transport.enqueue({ ok: true, status: 200, body: { number_of_unread_notifications: 1 } });

    await makeUI(client).showMessagesList();
    (shadow()!.querySelector('.grovs-item') as HTMLElement).click();
    expect(shadow()!.querySelector('.grovs-item')!.getAttribute('data-read')).toBe('true');
    expect(shadow()!.querySelector('.grovs-badge')!.getAttribute('data-count')).toBe('0');
  });

  it('renders a configured list title', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { notifications: [] } });

    await makeUI(client, { title: 'Inbox' }).showMessagesList();
    expect(shadow()!.querySelector('.grovs-heading')!.textContent).toBe('Inbox');
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

  it('renders the detail view as a themed card with the sandboxed iframe', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);

    makeUI(client).openPage({
      id: 7,
      title: 'Hello',
      subtitle: '',
      read: false,
      access_url: 'https://msg.example/x',
    });

    const modal = document.getElementById('Grovs-page-modal-7')!;
    const root = modal.shadowRoot!;
    expect(root.querySelector('style')).not.toBeNull();
    expect(root.querySelector('.grovs-detail-card')).not.toBeNull();
    expect(root.querySelector('.grovs-heading')!.textContent).toBe('Hello');
    const frame = root.querySelector('iframe')!;
    // No allow-same-origin: the frame cannot reach the embedding document.
    // allow-popups-to-escape-sandbox so a link out of a message opens a
    // working page rather than one with an opaque origin.
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-popups allow-forms allow-popups-to-escape-sandbox',
    );
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.src).toBe('https://msg.example/x');
  });

  // Notification#access_url arrives scheme-less; without the prepend every body is blank.
  it('prepends https:// to a scheme-less access_url like iOS does', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);

    makeUI(client).openPage({
      id: 9,
      title: 'T',
      subtitle: '',
      read: false,
      access_url: 'test1df3.sqd.link/mm/n0aFYv',
    });

    const frame = document
      .getElementById('Grovs-page-modal-9')!
      .shadowRoot!.querySelector('iframe')!;
    expect(frame.src).toBe('https://test1df3.sqd.link/mm/n0aFYv');
  });

  it('resolves safeUrl edge cases without ever reaching the customer origin', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    const ui = makeUI(client);

    const frameSrc = (id: number, accessUrl: string) => {
      ui.openPage({ id, title: 'T', subtitle: '', read: false, access_url: accessUrl });
      return document.getElementById(`Grovs-page-modal-${id}`)!.shadowRoot!.querySelector('iframe')!
        .src;
    };

    expect(frameSrc(20, 'httpbin.org/x')).toBe('https://httpbin.org/x');
    expect(frameSrc(21, 'HTTP://example.com/p')).toBe('http://example.com/p');
    expect(frameSrc(22, '//evil.example/x')).toBe('https://evil.example/x');
    expect(frameSrc(23, '/relative/path')).toBe('https://relative/path');
    expect(frameSrc(24, 'data:text/html,<script>1</script>')).toBe('about:blank');
    expect(frameSrc(25, 'javascript:alert(1)')).toBe('about:blank');
  });

  // jsdom has no layout, so list geometry is spied where auto-fill must run.
  async function withGeometry(scrollHeight: number, clientHeight: number, fn: () => Promise<void>) {
    const scrollSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(scrollHeight);
    const clientSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(clientHeight);
    try {
      await fn();
    } finally {
      scrollSpy.mockRestore();
      clientSpy.mockRestore();
    }
  }

  const notificationPage = (ids: number[], read = false) => ({
    ok: true,
    status: 200,
    body: {
      notifications: ids.map((id) => ({
        id,
        title: `m${id}`,
        subtitle: '',
        read,
        access_url: 'https://x.com',
      })),
    },
  });

  it('stops auto-filling once the list actually overflows', async () => {
    await withGeometry(500, 100, async () => {
      const transport = new FakeTransport();
      const client = await authedClient(transport);
      transport.enqueue(notificationPage([1]));

      await makeUI(client).showMessagesList();
      expect(transport.requestsTo('/notifications_for_device')).toHaveLength(1);
    });
  });

  it('does not auto-fill before the list has layout', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue(notificationPage([1]));
    transport.enqueue(notificationPage([2]));

    await makeUI(client).showMessagesList();
    expect(transport.requestsTo('/notifications_for_device')).toHaveLength(1);
  });

  it('auto-loads pages until the backend runs out when the list cannot scroll', async () => {
    await withGeometry(50, 100, async () => {
      const transport = new FakeTransport();
      const client = await authedClient(transport);
      transport.enqueue(notificationPage([1, 2]));
      transport.enqueue(notificationPage([3]));
      transport.enqueue(notificationPage([]));

      await makeUI(client).showMessagesList();
      expect(shadow()!.querySelectorAll('.grovs-item')).toHaveLength(3);
      expect(transport.requestsTo('/notifications_for_device')).toHaveLength(3);
    });
  });

  it('loads the next page on scroll', async () => {
    await withGeometry(500, 100, async () => {
      const transport = new FakeTransport();
      const client = await authedClient(transport);
      transport.enqueue(notificationPage([1]));

      await makeUI(client).showMessagesList();
      expect(transport.requestsTo('/notifications_for_device')).toHaveLength(1);

      transport.enqueue(notificationPage([2]));
      const list = shadow()!.querySelector('.grovs-item-list') as HTMLElement;
      list.scrollTop = 300;
      list.dispatchEvent(new Event('scroll'));

      await vi.waitFor(() =>
        expect(shadow()!.querySelectorAll('.grovs-item')).toHaveLength(2),
      );
      expect(transport.requestsTo('/notifications_for_device')).toHaveLength(2);
    });
  });

  it('closes on Escape', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue(notificationPage([]));

    await makeUI(client).showMessagesList();
    expect(document.getElementById('Grovs-modal')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('Grovs-modal')).toBeNull();
  });

  it('Escape dismisses the topmost detail modal before the list', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue(notificationPage([1]));

    const ui = makeUI(client);
    await ui.showMessagesList();
    ui.openPage({ id: 5, title: 'T', subtitle: '', read: false, access_url: 'https://x.com' });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('Grovs-page-modal-5')).toBeNull();
    expect(document.getElementById('Grovs-modal')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('Grovs-modal')).toBeNull();
  });

  it('keeps the per-row tally when the unread request fails', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue(notificationPage([1, 2]));
    transport.enqueueStatus(500);

    await makeUI(client).showMessagesList();
    expect(shadow()!.querySelector('.grovs-badge')!.getAttribute('data-count')).toBe('2');
  });

  it('removes the keydown listener when the last detail modal closes', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    const adds = vi.spyOn(document, 'addEventListener');
    const removes = vi.spyOn(document, 'removeEventListener');
    try {
      const ui = makeUI(client);
      ui.openPage({ id: 3, title: 'T', subtitle: '', read: false, access_url: 'https://x.com' });
      (document
        .getElementById('Grovs-page-modal-3')!
        .shadowRoot!.querySelector('.grovs-close') as HTMLElement).click();

      const keydownAdds = adds.mock.calls.filter(([type]) => type === 'keydown').length;
      const keydownRemoves = removes.mock.calls.filter(([type]) => type === 'keydown').length;
      expect(keydownAdds).toBe(keydownRemoves);
    } finally {
      adds.mockRestore();
      removes.mockRestore();
    }
  });

  it('opens a row with the keyboard', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue(notificationPage([7]));

    await makeUI(client).showMessagesList();
    const row = shadow()!.querySelector('.grovs-item') as HTMLElement;
    expect(row.getAttribute('role')).toBe('button');
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(document.getElementById('Grovs-page-modal-7')).not.toBeNull();
  });

  it('treats a page of already-rendered messages as exhaustion, not a loop', async () => {
    await withGeometry(50, 100, async () => {
      const transport = new FakeTransport();
      const client = await authedClient(transport);
      transport.enqueue(notificationPage([1, 2]));
      transport.enqueue(notificationPage([1, 2]));

      await makeUI(client).showMessagesList();
      expect(shadow()!.querySelectorAll('.grovs-item')).toHaveLength(2);
      expect(transport.requestsTo('/notifications_for_device')).toHaveLength(2);
    });
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

/** Drives the list with scripted pages, including one that can be held open. */
class StubMessagesService {
  readonly calls: number[] = [];
  readonly pages = new Map<number, GrovsMessage[]>();
  unread: number | null = null;
  private hold: Promise<void> | null = null;
  private open: (() => void) | null = null;

  blockNext(): void {
    this.hold = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  releaseHeld(): void {
    this.open?.();
    this.open = null;
    this.hold = null;
  }

  /** null is a failed request, as MessagesService.fetchMessages returns it. */
  failPages = new Set<number>();
  canShowUI = true;
  uiGuard(): () => boolean {
    return () => this.canShowUI;
  }

  async fetchMessages(page: number): Promise<GrovsMessage[] | null> {
    this.calls.push(page);
    // Captured at call time, as a real request is: a held page keeps the
    // answer it was going to give, not the one scripted while it waited.
    const response = this.failPages.has(page) ? null : (this.pages.get(page) ?? []);
    const held = this.hold;
    this.hold = null;
    if (held) await held;
    return response;
  }

  async getMessages(page: number): Promise<GrovsMessage[]> {
    return (await this.fetchMessages(page)) ?? [];
  }

  async fetchUnreadCount(): Promise<number | null> {
    return this.unread;
  }

  async markMessageAsRead(): Promise<boolean> {
    return true;
  }

  async messagesForAutomaticDisplay(): Promise<GrovsMessage[]> {
    return [];
  }
}

describe('MessagesUI pagination', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function message(id: number, read = false): GrovsMessage {
    return { id, title: `M${id}`, subtitle: 's', read, access_url: 'u' };
  }

  function uiOver(service: StubMessagesService): MessagesUI {
    return new MessagesUI(document, service as unknown as MessagesService, new Logger());
  }

  function list(): HTMLElement {
    const element = document
      .getElementById('Grovs-modal')
      ?.shadowRoot?.querySelector('.grovs-item-list');
    if (!element) throw new Error('list not mounted');
    return element as HTMLElement;
  }

  function badgeCount(): string | null {
    return (
      document.getElementById('Grovs-modal')?.shadowRoot?.querySelector('.grovs-badge')
        ?.textContent ?? null
    );
  }

  /** jsdom has no layout, so the scroll-driven fetch needs its metrics stubbed. */
  function scrollToBottom(element: HTMLElement): void {
    Object.defineProperty(element, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(element, 'scrollHeight', { value: 400, configurable: true });
    Object.defineProperty(element, 'scrollTop', { value: 300, configurable: true });
    element.dispatchEvent(new Event('scroll'));
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  // The server total covers pages that were never loaded, so tallying rows on
  // top of it takes the badge past the real figure: 16 unread became 17 after
  // loading the last unread message.
  it('does not add to the badge once the server total has landed', async () => {
    const service = new StubMessagesService();
    service.pages.set(1, [message(1)]);
    service.pages.set(2, [message(2)]);
    service.unread = 16;

    const ui = uiOver(service);
    await ui.showMessagesList();
    expect(badgeCount()).toBe('16');

    scrollToBottom(list());
    await settle();

    expect(service.calls).toContain(2);
    expect(badgeCount()).toBe('16');
    ui.close();
  });

  // "No messages yet" is a statement about the account. A failed request is a
  // statement about the network, and the two must not render the same.
  it('says a failed first page failed, and stays open to a retry', async () => {
    const service = new StubMessagesService();
    service.failPages.add(1);

    const ui = uiOver(service);
    await ui.showMessagesList();

    expect(list().textContent).toContain('could not be loaded');
    expect(list().textContent).not.toContain('No messages yet');

    // Not exhausted: the page that failed is still there to be fetched.
    service.failPages.clear();
    service.pages.set(1, [message(1)]);
    service.calls.length = 0;
    scrollToBottom(list());
    await settle();

    expect(service.calls).toEqual([1]);
    expect(list().querySelectorAll('.grovs-item')).toHaveLength(1);
    ui.close();
  });

  // `exhausted` and `isLoading` are shared with whatever list replaced the one
  // the request belonged to. A closed modal's empty final page marked the
  // reopened list exhausted, and page two never loaded again.
  it('lets a request from a closed modal not exhaust the list that replaced it', async () => {
    const service = new StubMessagesService();
    service.pages.set(1, [message(1)]);
    service.pages.set(2, []);

    const ui = uiOver(service);
    await ui.showMessagesList();

    // Page two is requested, then the modal closes before it answers.
    service.blockNext();
    scrollToBottom(list());
    ui.close();

    service.pages.set(2, [message(2)]);
    await ui.showMessagesList();
    service.releaseHeld();
    await settle();

    service.calls.length = 0;
    scrollToBottom(list());
    await settle();

    expect(service.calls).toContain(2);
    expect(list().querySelectorAll('.grovs-item')).toHaveLength(2);
    ui.close();
  });
});
