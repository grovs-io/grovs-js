import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBulkStorage, SwitchableStorage } from '../../src/storage/bulk-storage';
import { CookieStorage } from '../../src/storage/cookie-storage';
import { LocalStorageAdapter } from '../../src/storage/local-storage';
import { MemoryStorage } from '../../src/storage/memory-storage';
import { GrovsClient } from '../../src/core/client';
import { Logger } from '../../src/logging/logger';
import * as environment from '../../src/core/environment';
import { FakeTransport } from '../helpers/fake-transport';

const AUTH_OK = {
  ok: true,
  status: 200,
  body: { linksquared: 'v1', sdk_identifier: null, sdk_attributes: null },
};

function clearBrowserStorage(): void {
  localStorage.clear();
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
  });
}

describe('resolveBulkStorage', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * The regression this file exists for. Browsers cap a single cookie at
   * roughly 4 KB and silently ignore an oversized document.cookie assignment,
   * so a cookie-backed queue stops persisting at ~25 events with no error.
   * jsdom enforces no such limit, which is why every other test passed while
   * the queue was unwritable in production.
   */
  it('never returns a cookie store, even when cookies are available', () => {
    vi.spyOn(environment, 'probeCookies').mockReturnValue(true);
    vi.spyOn(environment, 'probeLocalStorage').mockReturnValue(true);

    const storage = resolveBulkStorage(new Logger());

    expect(storage).not.toBeInstanceOf(CookieStorage);
    expect(storage).toBeInstanceOf(LocalStorageAdapter);
  });

  it('falls back to memory when localStorage is unavailable', () => {
    vi.spyOn(environment, 'probeLocalStorage').mockReturnValue(false);
    expect(resolveBulkStorage(new Logger())).toBeInstanceOf(MemoryStorage);
  });

  it('warns when nothing durable is available', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(environment, 'probeLocalStorage').mockReturnValue(false);
    const logger = new Logger();
    logger.setLevel('warn');

    resolveBulkStorage(logger);

    expect(String(spy.mock.calls[0]?.[0])).toContain('will not survive a reload');
  });

  it('holds a queue far larger than a cookie could', () => {
    vi.spyOn(environment, 'probeLocalStorage').mockReturnValue(true);
    const storage = resolveBulkStorage(new Logger());

    const payload = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: `e-${i}` })));
    expect(payload.length).toBeGreaterThan(4096);

    storage.set('grovs_events', payload);
    expect(storage.get('grovs_events')).toBe(payload);
  });
});

describe('SwitchableStorage', () => {
  it('delegates to its current target', () => {
    const first = new MemoryStorage();
    const s = new SwitchableStorage(first);
    s.set('k', 'v');
    expect(first.get('k')).toBe('v');
  });

  it('carries named keys across on switch', () => {
    const first = new MemoryStorage();
    const second = new MemoryStorage();
    const s = new SwitchableStorage(first);
    s.set('keep', 'yes');
    s.set('drop', 'no');

    s.switchTo(second, ['keep']);

    expect(second.get('keep')).toBe('yes');
    expect(second.get('drop')).toBeNull();
    expect(s.get('keep')).toBe('yes');
  });

  it('repoints every holder at once, because they share the reference', () => {
    const first = new MemoryStorage();
    const second = new MemoryStorage();
    const shared = new SwitchableStorage(first);

    // Two collaborators constructed against the same indirection.
    const holderA = shared;
    const holderB = shared;

    shared.switchTo(second, []);
    holderA.set('a', '1');
    holderB.set('b', '2');

    expect(second.get('a')).toBe('1');
    expect(second.get('b')).toBe('2');
    expect(first.get('a')).toBeNull();
  });
});

describe('client storage wiring', () => {
  beforeEach(clearBrowserStorage);

  it('keeps the event queue out of cookies', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();

    client.track('x', { blob: 'y'.repeat(5000) });
    await new Promise((r) => setTimeout(r, 1100));

    expect(document.cookie).not.toContain('grovs_events');
    expect(localStorage.getItem('grovs_events')).toContain('y');
    client.shutdown();
  });

  it('keeps the identifier in a cookie, where it belongs', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k' }, { transport, autoStartEvents: false });
    await client.configure();

    expect(document.cookie).toContain('linksquared=v1');
    expect(localStorage.getItem('linksquared')).toBe('v1');
    client.shutdown();
  });

  // Previously the session and the deeplink resolver held the original memory
  // store forever, so a consent-mode integrator lost both on every reload.
  it('moves the session and captured path to durable storage on consent', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();
    await client.grantConsent();

    const sessionId = client.sessionManager.currentSessionId();
    client.track('after-consent');
    await new Promise((r) => setTimeout(r, 1100));

    // Both holders were constructed against the pre-consent memory store.
    // If they kept it, neither of these survives a reload.
    expect(localStorage.getItem('grovs_session_id')).toBe(sessionId);
    expect(localStorage.getItem('grovs_events')).toContain('after-consent');
    client.shutdown();
  });

  it('gives consent-mode users the identity mirror once consent lands', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();
    await client.grantConsent();

    expect(document.cookie).toContain('linksquared=v1');
    expect(localStorage.getItem('linksquared')).toBe('v1');
    client.shutdown();
  });

  // Consent revoked must mean persistence revoked, which is the guarantee
  // consent mode sells.
  it('returns to memory-only storage on reset in consent mode', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();
    await client.grantConsent();

    client.reset();
    client.sessionManager.currentSessionId();

    expect(localStorage.getItem('grovs_session_id')).toBeNull();
    expect(localStorage.getItem('linksquared')).toBeNull();
    expect(document.cookie).not.toContain('linksquared');
  });

  /**
   * The constructor reads identity before consent, when the mirrored store
   * does not exist yet — so without a re-read the returning visitor
   * authenticates with no LINKSQUARED header, the backend mints a fresh
   * identifier, and they are counted as a new install rather than recognised.
   */
  it('loads an existing identity before authenticating on consent', async () => {
    document.cookie = 'linksquared=returning-visitor;path=/';
    localStorage.setItem('linksquared', 'returning-visitor');

    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK);
    const client = new GrovsClient(
      { apiKey: 'k', requireConsent: true },
      { transport, autoStartEvents: false },
    );
    await client.configure();
    await client.grantConsent();

    const auth = transport.requestsTo('/authenticate')[0];
    expect(auth?.headers['LINKSQUARED']).toBe('returning-visitor');
    client.shutdown();
  });

  // React strict mode calls configure() twice. The History patch had a guard;
  // the event pipeline did not, so launch events doubled and two intervals
  // flushed forever.
  it('emits launch events once across a double configure()', async () => {
    const transport = new FakeTransport();
    transport.enqueue(AUTH_OK).enqueue(AUTH_OK);
    const client = new GrovsClient({ apiKey: 'k' }, { transport });

    await client.configure();
    await client.configure();

    const events = client.eventsHandler;
    void events;

    await client.flush();
    const sent = transport
      .requestsTo('/events/batch')
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events)
      .map((e) => e['event']);

    expect(sent.filter((e) => e === 'install')).toHaveLength(1);
    expect(sent.filter((e) => e === 'app_open')).toHaveLength(1);
    client.shutdown();
  });
});
