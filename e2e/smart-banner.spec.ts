import { expect, test } from '@playwright/test';

const BANNER = {
  id: 1,
  platforms: ['ios', 'android'],
  url_include: [],
  url_exclude: [],
  position: 'bottom',
  title: 'Get the app',
  subtitle: null,
  button_text: 'Open',
  background_color: '#ffffff',
  text_color: '#111111',
  button_color: '#4f46e5',
  button_text_color: '#ffffff',
  icon_url: null,
  dismiss_days: 7,
  default_link: 'https://go.e2e.test/default',
};

test.beforeEach(async ({ page }) => {
  await page.route('https://sdk.e2e.test/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
        body: JSON.stringify(body),
      });
    if (route.request().method() === 'OPTIONS') return json({});
    if (url.pathname.endsWith('/authenticate')) {
      return json({ linksquared: 'e2e-visitor', has_smart_banners: true });
    }
    if (url.pathname.endsWith('/smart_banners')) return json({ smart_banners: [BANNER] });
    if (url.pathname.endsWith('/smart_banners/1/link')) {
      const body = route.request().postDataJSON() as { data: { product?: string } };
      return json({ link: `https://go.e2e.test/p/${body.data.product ?? 'none'}` });
    }
    return json({});
  });
});

test('renders, swaps in the page link, and stays dismissed', async ({ page }) => {
  await page.goto('/e2e/smart-banner.html');
  const button = page.locator('#grovs-smart-banner').locator('a.button');
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('href', 'https://go.e2e.test/p/42');

  await page.locator('#grovs-smart-banner').locator('button.close').click();
  await expect(page.locator('#grovs-smart-banner')).toHaveCount(0);

  await page.reload();
  await page.waitForTimeout(500);
  await expect(page.locator('#grovs-smart-banner')).toHaveCount(0);
});

test('follows the hash route on a hash-routed page', async ({ page }) => {
  await page.route('https://sdk.e2e.test/**/smart_banners', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
      body: JSON.stringify({ smart_banners: [{ ...BANNER, url_include: ['/product/*'] }] }),
    }),
  );
  await page.goto('/e2e/smart-banner-hash.html#/product/7');
  const button = page.locator('#grovs-smart-banner').locator('a.button');
  await expect(button).toHaveAttribute('href', 'https://go.e2e.test/p/7');

  await page.evaluate(() => {
    location.hash = '#/product/8';
  });
  await expect(button).toHaveAttribute('href', 'https://go.e2e.test/p/8');

  await page.evaluate(() => {
    location.hash = '#/about';
  });
  await expect(page.locator('#grovs-smart-banner')).toHaveCount(0);
});
