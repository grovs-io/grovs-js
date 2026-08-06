import { describe, expect, it, vi } from 'vitest';
import { GrovsClient } from '../../src/core/client';
import { LinkGenerator } from '../../src/links/links';
import { FakeTransport } from '../helpers/fake-transport';
import { FakeStorage } from '../helpers/fake-storage';
import { GrovsError } from '../../src/net/errors';

const AUTH_OK = {
  ok: true,
  status: 200,
  body: { linksquared: 'v1', sdk_identifier: null, sdk_attributes: null },
};

async function authedClient(transport: FakeTransport, onError?: () => void) {
  transport.enqueue(AUTH_OK).enqueue({ ok: true, status: 200, body: { data: null } });
  const client = new GrovsClient(
    { apiKey: 'k', ...(onError ? { onError } : {}) },
    { transport, storage: new FakeStorage() },
  );
  await client.configure();
  return client;
}

describe('LinkGenerator', () => {
  it('returns the generated link', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    transport.enqueue({ ok: true, status: 200, body: { link: 'https://sqd.link/abc' } });

    const link = await new LinkGenerator(client).generateLink({ title: 'T' });
    expect(link).toBe('https://sqd.link/abc');
  });

  // v1 called error() then issued the request anyway, so the caller got both
  // an error and, moments later, a success.
  it('issues no request and returns null when unauthenticated', async () => {
    const onError = vi.fn();
    const transport = new FakeTransport();
    const client = new GrovsClient({ apiKey: 'k', onError }, { transport, storage: new FakeStorage() });

    const link = await new LinkGenerator(client).generateLink({ title: 'T' });

    expect(link).toBeNull();
    expect(transport.requestsTo('/create_link')).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(
      GrovsError.linkGenerationFailed,
      expect.stringContaining('not authenticated'),
    );
  });

  it('reports linkGenerationFailed when the response carries no link', async () => {
    const onError = vi.fn();
    const transport = new FakeTransport();
    const client = await authedClient(transport, onError);
    transport.enqueue({ ok: true, status: 200, body: {} });

    const link = await new LinkGenerator(client).generateLink({ title: 'T' });

    expect(link).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      GrovsError.linkGenerationFailed,
      expect.stringContaining('redirect rules'),
    );
  });

  it('reports linkGenerationFailed on a transport failure', async () => {
    const onError = vi.fn();
    const transport = new FakeTransport();
    const client = await authedClient(transport, onError);
    transport.enqueueStatus(500, { error: 'boom' });

    const link = await new LinkGenerator(client).generateLink({ title: 'T' });

    expect(link).toBeNull();
    expect(onError).toHaveBeenCalledWith(GrovsError.linkGenerationFailed, expect.any(String));
  });

  it('returns null without a request when the SDK is disabled', async () => {
    const transport = new FakeTransport();
    const client = await authedClient(transport);
    client.setEnabled(false);
    transport.requests.length = 0;

    const link = await new LinkGenerator(client).generateLink({ title: 'T' });
    expect(link).toBeNull();
    expect(transport.requests).toHaveLength(0);
  });

  it('rejects an empty-string link from the backend', async () => {
    const onError = vi.fn();
    const transport = new FakeTransport();
    const client = await authedClient(transport, onError);
    transport.enqueue({ ok: true, status: 200, body: { link: '' } });

    await expect(new LinkGenerator(client).generateLink({ title: 'T' })).resolves.toBeNull();
    expect(onError).toHaveBeenCalled();
  });
});
