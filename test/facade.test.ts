import { beforeEach, describe, expect, it, vi } from 'vitest';
import Grovs from '../src/index';
import { GrovsClient } from '../src/core/client';
import { __resetCoexistenceState } from '../src/compat/v1';
import { FakeTransport } from './helpers/fake-transport';
import { FakeStorage } from './helpers/fake-storage';

describe('public facade', () => {
  it('exposes the v2 surface', () => {
    expect(typeof Grovs.configure).toBe('function');
    expect(typeof Grovs.generateLink).toBe('function');
    expect(typeof Grovs.setUserIdentifier).toBe('function');
    expect(typeof Grovs.setUserAttributes).toBe('function');
    expect(typeof Grovs.isAuthenticated).toBe('function');
    expect(typeof Grovs.setEnabled).toBe('function');
    expect(typeof Grovs.setDebugLevel).toBe('function');
    expect(typeof Grovs.showMessagesList).toBe('function');
    expect(typeof Grovs.getMessages).toBe('function');
    expect(typeof Grovs.numberOfUnreadMessages).toBe('function');
    expect(typeof Grovs.markMessageAsRead).toBe('function');
    expect(typeof Grovs.allReceivedPayloadsSinceStartup).toBe('function');
    expect(typeof Grovs.lastReceivedPayload).toBe('function');
  });

  it('exposes the v1 class for existing integrators', () => {
    expect(typeof Grovs.V1).toBe('function');
  });

  // v1 integrators construct the SDK — `new Grovs(key, testEnv, cb)` from
  // npm, `new Grovs.default(...)` from the CDN bundle — and MIGRATION.md
  // promises that code keeps working without edits.
  it('is constructable as the v1 class', () => {
    const instance = new Grovs('k', false, () => undefined, {
      transport: new FakeTransport(),
      storage: new FakeStorage(),
    });
    expect(instance).toBeInstanceOf(Grovs.V1);
    expect(typeof instance.start).toBe('function');
  });

  it('reports not-authenticated before configure', () => {
    expect(Grovs.isAuthenticated()).toBe(false);
  });

  it('returns null from generateLink before configure rather than throwing', async () => {
    await expect(Grovs.generateLink({ title: 'T' })).resolves.toBeNull();
  });

  it('returns empty collections before configure rather than throwing', async () => {
    expect(Grovs.allReceivedPayloadsSinceStartup()).toEqual([]);
    expect(Grovs.lastReceivedPayload()).toBeNull();
    expect(Grovs.userIdentifier).toBeNull();
    expect(Grovs.userAttributes).toBeNull();
    await expect(Grovs.getMessages(1)).resolves.toEqual([]);
    await expect(Grovs.numberOfUnreadMessages()).resolves.toBe(0);
    await expect(Grovs.markMessageAsRead(1)).resolves.toBe(false);
    await expect(Grovs.showMessagesList()).resolves.toBeUndefined();
  });

  // The per-client pipeline guard cannot help here: a second configure()
  // builds a *new* client, so without this the previous one's flush interval,
  // lifecycle listeners and History patch stay live and everything is tracked
  // twice. React strict mode and hot reload both hit this path.
  it('retires the previous client when configure() is called twice', async () => {
    const shutdown = vi.spyOn(GrovsClient.prototype, 'shutdown');

    await Grovs.configure({ apiKey: 'k' });
    expect(shutdown).not.toHaveBeenCalled();

    await Grovs.configure({ apiKey: 'k' });
    expect(shutdown).toHaveBeenCalledTimes(1);

    shutdown.mockRestore();
  });

  // Two Grovs clients on one page is unsupported (docs/CONTEXT.md): it
  // double-counts auth, launch events, timers and sessions. Now that the v1
  // constructor and the v2 statics sit on the same export, mixing the two
  // eras is easy to do by accident — so it warns, once.
  describe('dual-entry warning', () => {
    beforeEach(() => __resetCoexistenceState());

    it('warns when the v1 constructor is used after configure()', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await Grovs.configure({ apiKey: 'k' });
      new Grovs('k', false, () => undefined, {
        transport: new FakeTransport(),
        storage: new FakeStorage(),
      });

      expect(spy.mock.calls.some(([msg]) => String(msg).includes('one page'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('warns when configure() runs after a v1 constructor, once only', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      new Grovs('k', false, () => undefined, {
        transport: new FakeTransport(),
        storage: new FakeStorage(),
      });
      await Grovs.configure({ apiKey: 'k' });
      await Grovs.configure({ apiKey: 'k' });

      const hits = spy.mock.calls.filter(([msg]) => String(msg).includes('one page'));
      expect(hits).toHaveLength(1);
      vi.restoreAllMocks();
    });

    it('stays silent when only one entry style is used', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await Grovs.configure({ apiKey: 'k' });
      await Grovs.configure({ apiKey: 'k' });

      expect(spy.mock.calls.some(([msg]) => String(msg).includes('one page'))).toBe(false);
      vi.restoreAllMocks();
    });
  });

  it('does not throw when identity setters are called before configure', () => {
    expect(() => Grovs.setUserIdentifier('x')).not.toThrow();
    expect(() => Grovs.setUserAttributes({ a: 1 })).not.toThrow();
    expect(() => Grovs.setEnabled(false)).not.toThrow();
    expect(() => Grovs.setDebugLevel('info')).not.toThrow();
  });
});
