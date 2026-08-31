import { beforeEach, describe, expect, it } from 'vitest';
import { DeeplinkResolver } from '../../src/links/deeplink';
import { FakeStorage } from '../helpers/fake-storage';

function make(url: string | null) {
  const storage = new FakeStorage();
  return { storage, resolver: new DeeplinkResolver(storage, () => url) };
}

describe('DeeplinkResolver', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
  });

  it('captures the Grovs query parameter and stores it', () => {
    const { resolver, storage: s } = make('https://site.com/page?Grovs=abc123');
    expect(resolver.capture()).toBe('abc123');
    expect(s.get('Grovs_path')).toBe('abc123');
  });

  it('decodes a percent-encoded parameter', () => {
    const { resolver } = make('https://site.com/?Grovs=a%2Fb');
    expect(resolver.capture()).toBe('a/b');
  });

  it('ignores the fragment when parsing', () => {
    const { resolver } = make('https://site.com/?Grovs=abc#section');
    expect(resolver.capture()).toBe('abc');
  });

  it('returns null when the parameter is absent', () => {
    const { resolver } = make('https://site.com/page');
    expect(resolver.capture()).toBeNull();
  });

  // The redirect page appends `linksquared` alongside `Grovs` for the legacy
  // SDK; a URL carrying only that one must still attribute.
  it('falls back to the legacy linksquared parameter', () => {
    const { resolver, storage: s } = make('https://site.com/?linksquared=abc123');
    expect(resolver.capture()).toBe('abc123');
    expect(s.get('Grovs_path')).toBe('abc123');
  });

  it('accepts case-mangled parameter names', () => {
    expect(make('https://site.com/?grovs=lower').resolver.capture()).toBe('lower');
    expect(make('https://site.com/?GROVS=upper').resolver.capture()).toBe('upper');
    expect(make('https://site.com/?LinkSquared=mixed').resolver.capture()).toBe('mixed');
  });

  it('prefers Grovs over linksquared when both are present', () => {
    const { resolver } = make('https://site.com/?linksquared=old&Grovs=new');
    expect(resolver.capture()).toBe('new');
  });

  it('returns null rather than throwing on an unparseable URL', () => {
    const { resolver } = make('not a url');
    expect(resolver.capture()).toBeNull();
  });

  it('returns null when there is no URL at all (SSR)', () => {
    const { resolver } = make(null);
    expect(resolver.capture()).toBeNull();
  });

  // The T2 regression. v1 deleted on read, so callers after the first saw null.
  it('returns the same value on three consecutive reads', () => {
    storage.set('Grovs_path', 'abc123');
    const resolver = new DeeplinkResolver(storage, () => 'https://site.com/');
    expect(resolver.getStoredPath()).toBe('abc123');
    expect(resolver.getStoredPath()).toBe('abc123');
    expect(resolver.getStoredPath()).toBe('abc123');
  });

  it('returns the value once from consume, then null', () => {
    storage.set('Grovs_path', 'abc123');
    const resolver = new DeeplinkResolver(storage, () => 'https://site.com/');
    expect(resolver.consumeStoredPath()).toBe('abc123');
    expect(resolver.consumeStoredPath()).toBeNull();
    expect(resolver.getStoredPath()).toBeNull();
  });

  it('captures a fresh parameter over a previously stored one', () => {
    storage.set('Grovs_path', 'old');
    const resolver = new DeeplinkResolver(storage, () => 'https://site.com/?Grovs=new');
    expect(resolver.capture()).toBe('new');
    expect(resolver.getStoredPath()).toBe('new');
  });
});
