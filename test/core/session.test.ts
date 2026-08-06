import { describe, expect, it } from 'vitest';
import { SessionManager, SESSION_ID_KEY, SESSION_ACTIVITY_KEY } from '../../src/core/session';
import { FakeStorage } from '../helpers/fake-storage';
import { FakeClock } from '../helpers/fake-clock';

function make() {
  const storage = new FakeStorage();
  const clock = new FakeClock();
  return { storage, clock, session: new SessionManager(storage, clock) };
}

describe('SessionManager', () => {
  it('mints a session id on first use', () => {
    const { session, storage } = make();
    const id = session.currentSessionId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.get(SESSION_ID_KEY)).toBe(id);
  });

  it('returns the same id on repeated reads', () => {
    const { session } = make();
    expect(session.currentSessionId()).toBe(session.currentSessionId());
  });

  // Spec A6: a session is a person, not a tab. Three tabs share localStorage,
  // so they share the session.
  it('shares one id across simulated tabs', () => {
    const storage = new FakeStorage();
    const clock = new FakeClock();
    const tabA = new SessionManager(storage, clock);
    const tabB = new SessionManager(storage, clock);
    const tabC = new SessionManager(storage, clock);

    const id = tabA.currentSessionId();
    expect(tabB.currentSessionId()).toBe(id);
    expect(tabC.currentSessionId()).toBe(id);
  });

  it('does not rotate after 20 minutes of idle', () => {
    const { session, clock } = make();
    const first = session.currentSessionId();
    clock.advanceMinutes(20);
    expect(session.currentSessionId()).toBe(first);
  });

  it('rotates after 45 minutes of idle', () => {
    const { session, clock } = make();
    const first = session.currentSessionId();
    clock.advanceMinutes(45);
    expect(session.currentSessionId()).not.toBe(first);
  });

  // Each case starts fresh: reading the session refreshes last activity, so
  // two reads in one scenario would only ever measure the gap between them.
  it('does not rotate at exactly 30 minutes', () => {
    const { session, clock } = make();
    const first = session.currentSessionId();
    clock.advance(30 * 60_000);
    expect(session.currentSessionId()).toBe(first);
  });

  it('rotates one millisecond past 30 minutes', () => {
    const { session, clock } = make();
    const first = session.currentSessionId();
    clock.advance(30 * 60_000 + 1);
    expect(session.currentSessionId()).not.toBe(first);
  });

  it('refreshes the idle window on each read, so steady use never rotates', () => {
    const { session, clock } = make();
    const first = session.currentSessionId();
    for (let i = 0; i < 10; i += 1) {
      clock.advanceMinutes(25);
      expect(session.currentSessionId()).toBe(first);
    }
  });

  // The failure mode A6 names: one tab going idle must not rotate the session
  // out from under two that are still active.
  it('does not rotate when another tab stayed active', () => {
    const storage = new FakeStorage();
    const clock = new FakeClock();
    const idleTab = new SessionManager(storage, clock);
    const activeTab = new SessionManager(storage, clock);

    const id = idleTab.currentSessionId();

    // 25 minutes pass; the active tab touches the session twice.
    clock.advanceMinutes(25);
    activeTab.currentSessionId();
    clock.advanceMinutes(25);
    activeTab.currentSessionId();

    // The idle tab wakes 50 minutes after its own last read, but only 25
    // minutes after the shared last activity.
    expect(idleTab.currentSessionId()).toBe(id);
  });

  it('stamps last activity on every read', () => {
    const { session, storage, clock } = make();
    session.currentSessionId();
    expect(storage.get(SESSION_ACTIVITY_KEY)).toBe(String(clock.now()));

    clock.advanceMinutes(5);
    session.currentSessionId();
    expect(storage.get(SESSION_ACTIVITY_KEY)).toBe(String(clock.now()));
  });

  // Last-writer-wins is correct because the field is monotonic, but it has to
  // be written deliberately as such (spec A6).
  it('never moves last activity backwards', () => {
    const storage = new FakeStorage();
    const clock = new FakeClock();
    const session = new SessionManager(storage, clock);

    session.currentSessionId();
    const later = clock.now() + 60_000;
    storage.set(SESSION_ACTIVITY_KEY, String(later));

    session.currentSessionId();
    expect(Number(storage.get(SESSION_ACTIVITY_KEY))).toBe(later);
  });

  it('treats corrupt stored activity as no activity and keeps working', () => {
    const { session, storage } = make();
    const first = session.currentSessionId();
    storage.set(SESSION_ACTIVITY_KEY, 'not-a-number');
    expect(session.currentSessionId()).toBe(first);
  });

  it('reports whether the last read rotated the session', () => {
    const { session, clock } = make();
    session.currentSessionId();
    expect(session.rotateIfIdle()).toBe(false);

    clock.advanceMinutes(45);
    expect(session.rotateIfIdle()).toBe(true);
    expect(session.rotateIfIdle()).toBe(false);
  });

  it('clears both keys on reset', () => {
    const { session, storage } = make();
    session.currentSessionId();
    session.reset();
    expect(storage.get(SESSION_ID_KEY)).toBeNull();
    expect(storage.get(SESSION_ACTIVITY_KEY)).toBeNull();
  });
});
