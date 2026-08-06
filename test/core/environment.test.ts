import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPageIdentifier,
  isBrowser,
  probeCookies,
  probeLocalStorage,
} from '../../src/core/environment';

describe('environment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a browser when window and document exist', () => {
    expect(isBrowser()).toBe(true);
  });

  it('reports no browser when window is undefined', () => {
    vi.stubGlobal('window', undefined);
    expect(isBrowser()).toBe(false);
  });

  it('builds the IDENTIFIER from protocol, hostname and port', () => {
    expect(getPageIdentifier()).toBe('http://localhost:3000');
  });

  it('returns null for the identifier outside a browser', () => {
    vi.stubGlobal('window', undefined);
    expect(getPageIdentifier()).toBeNull();
  });

  it('detects a working localStorage', () => {
    expect(probeLocalStorage()).toBe(true);
  });

  it('reports localStorage unavailable when setItem throws', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
      removeItem: () => undefined,
    });
    expect(probeLocalStorage()).toBe(false);
  });

  it('detects cookie support', () => {
    expect(probeCookies()).toBe(true);
  });
});
