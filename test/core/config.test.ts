import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/core/config';
import { Context } from '../../src/core/context';

describe('resolveConfig', () => {
  it('defaults to the production endpoint', () => {
    const c = resolveConfig({ apiKey: 'k' });
    expect(c.endpoint).toBe('https://sdk.sqd.link/api/v1/sdk');
  });

  it('appends the api path to a custom baseURL', () => {
    const c = resolveConfig({ apiKey: 'k', baseURL: 'https://sdk.self-hosted.example' });
    expect(c.endpoint).toBe('https://sdk.self-hosted.example/api/v1/sdk');
  });

  it('strips a trailing slash from a custom baseURL', () => {
    const c = resolveConfig({ apiKey: 'k', baseURL: 'https://sdk.example.com/' });
    expect(c.endpoint).toBe('https://sdk.example.com/api/v1/sdk');
  });

  it('defaults testEnvironment to false and debugLevel to error', () => {
    const c = resolveConfig({ apiKey: 'k' });
    expect(c.testEnvironment).toBe(false);
    expect(c.debugLevel).toBe('error');
  });

  it('rejects an empty api key', () => {
    expect(() => resolveConfig({ apiKey: '' })).toThrow(/API key/i);
    expect(() => resolveConfig({ apiKey: '   ' })).toThrow(/API key/i);
  });

  it('normalises absent callbacks to null', () => {
    const c = resolveConfig({ apiKey: 'k' });
    expect(c.onDeeplink).toBeNull();
    expect(c.onError).toBeNull();
  });
});

describe('Context', () => {
  it('starts empty and unauthenticated', () => {
    const ctx = new Context();
    expect(ctx.linksquaredId).toBeNull();
    expect(ctx.userIdentifier).toBeNull();
    expect(ctx.userAttributes).toBeNull();
    expect(ctx.authenticated).toBe(false);
  });

  it('clears every field on reset', () => {
    const ctx = new Context();
    ctx.linksquaredId = 'id';
    ctx.userIdentifier = 'user';
    ctx.userAttributes = { plan: 'pro' };
    ctx.authenticated = true;
    ctx.reset();
    expect(ctx.linksquaredId).toBeNull();
    expect(ctx.userIdentifier).toBeNull();
    expect(ctx.userAttributes).toBeNull();
    expect(ctx.authenticated).toBe(false);
  });
});
