import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHARED, readJson } from './shared';

/**
 * The shared files are copies. The backend owns them and writes manifest.json
 * when it copies; an edit made here would silently fork the contract.
 */
describe('shared in-app files', () => {
  const manifest = readJson('manifest.json') as Record<string, string>;

  it('lists the four files the backend copies', () => {
    expect(Object.keys(manifest).sort()).toEqual(
      ['README.md', 'cases.json', 'cases.schema.json', 'definition.schema.json'].sort(),
    );
  });

  for (const name of Object.keys(manifest)) {
    it(`${name} is exactly what the backend copied`, () => {
      const hash = createHash('sha256').update(readFileSync(`${SHARED}/${name}`)).digest('hex');
      expect(hash).toBe(manifest[name]);
    });
  }
});
