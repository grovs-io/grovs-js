import { afterEach, describe, expect, it, vi } from 'vitest';
import { LifecycleTracker } from '../../src/tracking/lifecycle';
import { FakeClock } from '../helpers/fake-clock';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
}

function make() {
  const clock = new FakeClock();
  const onEngagement = vi.fn();
  const onExit = vi.fn();
  const onHide = vi.fn();
  const tracker = new LifecycleTracker({ clock, onEngagement, onExit, onHide });
  return { clock, onEngagement, onExit, onHide, tracker };
}

describe('LifecycleTracker', () => {
  afterEach(() => {
    setVisibility('visible');
  });

  // The defect this exists to repay: v1 listened only for `focus`, which never
  // fires on tab close, losing the final time_spent for every session.
  it('emits engagement and flushes on pagehide', () => {
    setVisibility('visible');
    const { tracker, clock, onEngagement, onExit } = make();
    tracker.start();

    clock.advance(45_000);
    window.dispatchEvent(new Event('pagehide'));

    expect(onEngagement).toHaveBeenCalledWith(45);
    expect(onExit).toHaveBeenCalledOnce();
    tracker.stop();
  });

  // A tab switch is not an exit: it happens dozens of times a session, and
  // the keepalive path never checks its result.
  it('uses the normal flush on a tab switch, not the terminal exit path', () => {
    setVisibility('visible');
    const { tracker, clock, onEngagement, onExit, onHide } = make();
    tracker.start();

    clock.advance(5000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(onHide).toHaveBeenCalledOnce();
    expect(onExit).not.toHaveBeenCalled();
    expect(onEngagement).toHaveBeenCalledWith(5);
    tracker.stop();
  });

  it('emits engagement when the tab is hidden', () => {
    setVisibility('visible');
    const { tracker, clock, onEngagement } = make();
    tracker.start();

    clock.advance(30_000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(onEngagement).toHaveBeenCalledWith(30);
    tracker.stop();
  });

  it('restarts the window when the tab becomes visible again', () => {
    setVisibility('visible');
    const { tracker, clock, onEngagement } = make();
    tracker.start();

    clock.advance(10_000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onEngagement).toHaveBeenLastCalledWith(10);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    clock.advance(20_000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(onEngagement).toHaveBeenLastCalledWith(20);
    tracker.stop();
  });

  // A visibilitychange immediately followed by pagehide is the normal close
  // sequence; counting the same seconds twice would inflate every session.
  it('does not double-count when hide is followed by pagehide', () => {
    setVisibility('visible');
    const { tracker, clock, onEngagement } = make();
    tracker.start();

    clock.advance(15_000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));

    expect(onEngagement).toHaveBeenCalledTimes(1);
    tracker.stop();
  });

  it('still flushes on pagehide even with no engagement to report', () => {
    setVisibility('visible');
    const { tracker, onExit } = make();
    tracker.start();

    window.dispatchEvent(new Event('pagehide'));
    expect(onExit).toHaveBeenCalledOnce();
    tracker.stop();
  });

  it('reports nothing for a sub-second visit', () => {
    setVisibility('visible');
    const { tracker, clock, onEngagement } = make();
    tracker.start();

    clock.advance(400);
    window.dispatchEvent(new Event('pagehide'));

    expect(onEngagement).not.toHaveBeenCalled();
    tracker.stop();
  });

  it('starts with no open window when the page loads hidden', () => {
    setVisibility('hidden');
    const { tracker, clock, onEngagement } = make();
    tracker.start();

    clock.advance(60_000);
    window.dispatchEvent(new Event('pagehide'));

    expect(onEngagement).not.toHaveBeenCalled();
    tracker.stop();
  });

  it('detaches its listeners on stop', () => {
    setVisibility('visible');
    const { tracker, clock, onExit } = make();
    tracker.start();
    tracker.stop();

    clock.advance(30_000);
    window.dispatchEvent(new Event('pagehide'));
    expect(onExit).not.toHaveBeenCalled();
  });
});
