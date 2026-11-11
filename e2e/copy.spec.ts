import { test, expect, type Page } from '@playwright/test';

async function checkDescriptions(page: Page) {
  const missing = await page.locator('[aria-describedby]').evaluateAll(elements => elements.flatMap(element =>
    (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && !document.getElementById(id))));
  expect(missing).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
}

test('concise stage copy retains help, disclosures and actions @mobile-smoke', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'geolocation', { value: {
    getCurrentPosition: (_success: unknown, failure: (error: { code: number }) => void) => failure({ code: 1 }),
  } }));
  await page.goto('/');
  await expect(page.getByText('What are you looking for?', { exact: true })).toBeVisible();
  await expect(page.locator('.principles, .header-tagline')).toHaveCount(0);
  await expect(page.getByText('Scripted preview', { exact: true })).toBeVisible();
  const disclosure = page.locator('.site-footer details');
  await expect(disclosure).not.toHaveAttribute('open');
  await disclosure.locator('summary').click();
  await expect(disclosure).toContainText('AI extraction is not independent verification.');
  await expect(disclosure).toContainText('Prices exclude shipping and delivery.');
  await expect(disclosure).toContainText('Records do not expire automatically');
  await disclosure.locator('summary').click();
  await checkDescriptions(page);
  await page.getByRole('textbox', { name: 'Your message' }).fill('Laptop for coding in Italy, budget €700');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Continue to Configure' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Review your brief.');
  await expect(page.getByLabel('Country', { exact: true })).toHaveAccessibleDescription('Its local currency is selected when supported.');
  await expect(page.getByText('Preferences can bend. Must-haves can’t.')).toBeVisible();
  await expect(page.locator('.aside-note, .config-bottom p')).toHaveCount(0);
  await checkDescriptions(page);
  await page.getByRole('button', { name: 'Find products' }).click();
  await expect(page.getByTestId('product-card')).toHaveCount(6);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Compare products.');
  await expect(page.locator('.learn-callout, .search-completed')).toHaveCount(0);
  await expect(page.getByLabel('Steer your results')).toHaveAccessibleDescription('Add a brand or requirement to search again with your existing brief.');
  await expect(page.getByTestId('product-card').first().getByRole('button', { name: 'Purchase options' })).toBeEnabled();
  await checkDescriptions(page);
});
