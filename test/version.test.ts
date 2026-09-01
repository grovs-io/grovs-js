import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SDK_VERSION } from '../src/version';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

describe('SDK_VERSION', () => {
  it('is the major.minor of the published package version', () => {
    expect(SDK_VERSION).toBe(pkg.version.split('.').slice(0, 2).join('.'));
  });
});
