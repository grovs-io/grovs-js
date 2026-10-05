// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRIDGE } from '../../src/inapp/bridge.generated';
import { minifyBridge } from '../../scripts/build-bridge.mjs';

describe('bridge.generated.ts', () => {
  it('is the minified copy of bridge.js', async () => {
    expect(BRIDGE).toBe(await minifyBridge(readFileSync('src/inapp/bridge.js', 'utf8')));
  });

  it('can sit inside an inline script', () => {
    expect(BRIDGE.toLowerCase()).not.toContain('</script');
    expect(BRIDGE.length).toBeLessThan(readFileSync('src/inapp/bridge.js', 'utf8').length);
  });
});
