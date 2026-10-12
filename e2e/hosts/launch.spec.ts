import { expect, test } from './support/fixtures';

test('the host serves and shows Host home with the SDK configured', async ({ host, page }) => {
  await host.open('/');
  await expect(page.locator('h1')).toHaveText('Host home');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hostConfigured?: boolean }).__hostConfigured === true)).toBe(true);
});
