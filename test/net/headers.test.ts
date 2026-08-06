import { describe, expect, it } from 'vitest';
import { buildHeaders } from '../../src/net/headers';
import { resolveConfig } from '../../src/core/config';
import { Context } from '../../src/core/context';
import { SDK_VERSION } from '../../src/version';

describe('buildHeaders', () => {
  it('uses PROJECT-KEY with a dash, not an underscore', () => {
    const h = buildHeaders(resolveConfig({ apiKey: 'abc' }), new Context(), 'https://x.com');
    expect(h['PROJECT-KEY']).toBe('abc');
    expect(h['PROJECT_KEY']).toBeUndefined();
  });

  it('prefixes the key with test_ in the test environment', () => {
    const h = buildHeaders(
      resolveConfig({ apiKey: 'abc', testEnvironment: true }),
      new Context(),
      'https://x.com',
    );
    expect(h['PROJECT-KEY']).toBe('test_abc');
  });

  it('sends PLATFORM web', () => {
    const h = buildHeaders(resolveConfig({ apiKey: 'k' }), new Context(), 'https://x.com');
    expect(h['PLATFORM']).toBe('web');
  });

  it('sends the SDK-VERSION header', () => {
    const h = buildHeaders(resolveConfig({ apiKey: 'k' }), new Context(), 'https://x.com');
    expect(h['SDK-VERSION']).toBe(SDK_VERSION);
  });

  it('sends IDENTIFIER verbatim', () => {
    const h = buildHeaders(resolveConfig({ apiKey: 'k' }), new Context(), 'https://app.example.com');
    expect(h['IDENTIFIER']).toBe('https://app.example.com');
  });

  it('omits IDENTIFIER when there is no page', () => {
    const h = buildHeaders(resolveConfig({ apiKey: 'k' }), new Context(), null);
    expect(h['IDENTIFIER']).toBeUndefined();
  });

  it('sends LINKSQUARED only once known', () => {
    const ctx = new Context();
    const before = buildHeaders(resolveConfig({ apiKey: 'k' }), ctx, 'https://x.com');
    expect(before['LINKSQUARED']).toBeUndefined();

    ctx.linksquaredId = 'visitor-1';
    const after = buildHeaders(resolveConfig({ apiKey: 'k' }), ctx, 'https://x.com');
    expect(after['LINKSQUARED']).toBe('visitor-1');
  });

  it('sends JSON content type', () => {
    const h = buildHeaders(resolveConfig({ apiKey: 'k' }), new Context(), 'https://x.com');
    expect(h['Content-Type']).toBe('application/json');
  });
});
