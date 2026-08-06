import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../../src/logging/logger';
import { GrovsError, grovsErrorName } from '../../src/net/errors';

describe('GrovsError', () => {
  it('uses the same numeric codes as iOS', () => {
    expect(GrovsError.authenticationFailed).toBe(1);
    expect(GrovsError.networkRequestFailed).toBe(2);
    expect(GrovsError.eventDispatchFailed).toBe(3);
    expect(GrovsError.linkGenerationFailed).toBe(4);
  });

  it('names codes the way iOS describes them', () => {
    expect(grovsErrorName(GrovsError.authenticationFailed)).toBe('authentication_failed');
    expect(grovsErrorName(GrovsError.linkGenerationFailed)).toBe('link_generation_failed');
  });
});

describe('Logger', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger();
    vi.restoreAllMocks();
  });

  it('suppresses info when the level is error', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logger.setLevel('error');
    logger.info('hidden');
    expect(spy).not.toHaveBeenCalled();
  });

  it('emits info when the level is info', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logger.setLevel('info');
    logger.info('shown');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain('shown');
  });

  it('defaults to error level, matching iOS', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logger.warn('hidden');
    expect(spy).not.toHaveBeenCalled();
  });

  it('dispatches to the onError callback', () => {
    const onError = vi.fn();
    logger.setOnError(onError);
    logger.reportError(GrovsError.authenticationFailed, 'bad key');
    expect(onError).toHaveBeenCalledWith(GrovsError.authenticationFailed, 'bad key');
  });

  it('does not let a throwing onError callback escape', () => {
    logger.setOnError(() => {
      throw new Error('integrator bug');
    });
    expect(() => logger.reportError(GrovsError.networkRequestFailed, 'x')).not.toThrow();
  });

  it('reports a once-keyed error only the first time', () => {
    const onError = vi.fn();
    logger.setOnError(onError);
    logger.reportErrorOnce('generateLink', GrovsError.networkRequestFailed, 'ssr');
    logger.reportErrorOnce('generateLink', GrovsError.networkRequestFailed, 'ssr');
    logger.reportErrorOnce('linkDetails', GrovsError.networkRequestFailed, 'ssr');
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
