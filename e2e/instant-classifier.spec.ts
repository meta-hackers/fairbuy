import { test, expect } from '@playwright/test';

const empty = { category: null, budget: null, condition: null, requirements: [], clarification: null };
const washingMachine = {
  ...empty, category: { value: 'Washing machine', evidence: 'washing machine' },
  budget: { amount: 700, currency: 'CHF', hard: true, evidence: 'under CHF 700' },
  requirements: [{ label: 'Quiet', hard: false, evidence: 'quiet' }],
  clarification: 'What maximum width and depth can you accommodate?',
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'geolocation', { value: {
    getCurrentPosition: (_success: unknown, failure: (error: { code: number }) => void) => failure({ code: 1 }),
  } }));
  // Explicit HTTP mocks: the browser suite never spends provider credits.
  await page.route('**/api/bootstrap', async route => {
    const original = await route.fetch(); const boot = await original.json();
    await route.fulfill({ json: { ...boot, instantClassifierConfigured: true } });
  });
});

test('debounces typing, shows every validated hint, and never makes the brief ready', { tag: '@mobile-smoke' }, async ({ page }) => {
  let calls = 0;
  await page.route('**/api/instant-classifier', async route => { calls++; await route.fulfill({ json: washingMachine }); });
  await page.goto('/');
  const preview = page.locator('.instant-classifier');
  const dots = page.locator('.instant-classifier-dots');
  await expect(preview).toHaveCount(0);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  const input = page.getByRole('textbox', { name: 'Your message' });
  await input.fill('washing');
  await expect(dots).toBeVisible();
  await page.clock.fastForward(400);
  await input.fill('A quiet washing machine under CHF 700 for a small apartment');
  await page.clock.fastForward(599);
  expect(calls).toBe(0);
  await expect(dots).toBeVisible();
  await page.clock.fastForward(1);
  await expect(preview.getByRole('listitem').filter({ hasText: 'Quiet' })).toBeVisible();
  expect(calls).toBe(1);
  await expect(preview.getByRole('listitem').filter({ hasText: 'Quiet' })).toHaveAttribute('title', 'From your text: “quiet”');
  await expect(preview.getByRole('listitem').filter({ hasText: 'Category' })).toHaveText('Category Washing machine');
  await expect(preview.getByRole('listitem').filter({ hasText: 'Budget' })).toHaveText('Budget CHF 700 · firm');
  await expect(preview.getByRole('listitem').filter({ hasText: 'Budget' })).toHaveAttribute('title', 'From your text: “under CHF 700”');
  await expect(preview.locator('.instant-classifier-question')).toHaveText('What maximum width and depth can you accommodate?');
  await expect(page.getByRole('button', { name: 'Continue to Configure' })).toBeDisabled();
  expect((await (await page.request.get('/api/bootstrap')).json()).session).toBeNull();
  await input.fill('baby');
  await expect(preview.getByRole('listitem')).toHaveCount(0);
  await input.fill('');
  await expect(preview).toHaveCount(0);
  await page.clock.fastForward(1000);
  expect(calls).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
});

test('ignores stale responses and shows a clarification on its own', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finished!: () => void;
  const staleHandled = new Promise<void>(resolve => { finished = resolve; });
  let firstStarted = false;
  await page.route('**/api/instant-classifier', async route => {
    if (route.request().postDataJSON().text === 'washing machine') {
      firstStarted = true; await gate;
      await route.fulfill({ json: washingMachine }).catch(() => {});
      finished();
    } else await route.fulfill({ json: { ...empty, clarification: 'Which baby product are you looking for?' } });
  });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: 'Your message' });
  await input.fill('washing machine');
  await expect.poll(() => firstStarted).toBe(true);
  await expect(page.locator('.instant-classifier-dots')).toBeVisible();
  const staleCancelled = page.waitForEvent('requestfailed', request =>
    request.url().endsWith('/api/instant-classifier') && request.postDataJSON().text === 'washing machine');
  await input.fill('baby');
  const dots = page.locator('.instant-classifier-dots');
  // A clarification-only result shows the question without any tags.
  await expect(dots).toBeVisible();
  await expect(dots).toHaveCount(0);
  await expect(page.locator('.instant-classifier-chips')).toHaveCount(0);
  await expect(page.locator('.instant-classifier-question')).toHaveText('Which baby product are you looking for?');
  release();
  await Promise.all([staleCancelled, staleHandled]);
  await expect(page.locator('.instant-classifier-chips')).toHaveCount(0);
  await expect(page.locator('.instant-classifier-question')).toHaveText('Which baby product are you looking for?');
});

test('quota failures show nothing and do not block Send', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/instant-classifier', async route => { calls++; await route.fulfill({ status: 429, json: { error: 'Allowance exhausted.' } }); });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: 'Your message' });
  await input.fill('A laptop for coding');
  await expect(page.locator('.instant-classifier-dots')).toBeVisible();
  await expect(page.locator('.instant-classifier')).toHaveCount(0);
  await input.fill('A laptop for coding in Italy, budget EUR 700');
  await expect(page.locator('.instant-classifier')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Continue to Configure' })).toBeEnabled();
  expect(calls).toBe(1);
});

test('does not send drafts during input-method composition or after submission', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/instant-classifier', async route => { calls++; await route.fulfill({ json: empty }); });
  await page.goto('/');
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  const input = page.getByRole('textbox', { name: 'Your message' });
  await input.dispatchEvent('compositionstart');
  await input.fill('laptop');
  await page.clock.fastForward(1000);
  expect(calls).toBe(0);
  await input.dispatchEvent('compositionend');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('log')).toContainText('which country');
  await page.clock.fastForward(1000);
  expect(calls).toBe(0);
});
