import { test, expect, type APIRequestContext } from '@playwright/test';

// State-rendering tests need a completed session, not another UI shopping journey.
async function discoveryBootstrap(request: APIRequestContext) {
  const headers = { 'X-Fairbuy-Request': '1' };
  const created = await request.post('/api/sessions', { headers });
  expect(created.status()).toBe(201);
  const session = await created.json();
  const answer = await request.post(`/api/sessions/${session.id}/ask`, {
    headers, data: { message: 'Laptop for coding in Italy, budget €700' },
  });
  expect(answer.status()).toBe(200);
  const discovery = await request.post(`/api/sessions/${session.id}/discovery`, { headers });
  expect(discovery.status()).toBe(202);
  await expect.poll(async () => {
    const response = await request.get(`/api/sessions/${session.id}`);
    expect(response.status()).toBe(200);
    return (await response.json()).rounds.at(-1)?.status;
  }).toBe('complete');
  const bootstrap = await request.get('/api/bootstrap');
  expect(bootstrap.status()).toBe(200);
  const boot = await bootstrap.json();
  expect(boot.session.id).toBe(session.id);
  expect(boot.session.rounds.at(-1).products).toHaveLength(6);
  return boot;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'geolocation', { value: {
    getCurrentPosition: (_success: unknown, failure: (error: { code: number }) => void) => failure({ code: 1 }),
  } }));
});

test('saved products without image URLs recover photos; failures report only safe metadata', async ({ page }) => {
  const boot = await discoveryBootstrap(page.request);
  // Demo products intentionally have no photos. Model a live saved search whose
  // offers exist but whose image enrichment previously failed.
  for (const product of boot.session.rounds.at(-1).products) {
    product.imageUrl = null;
    for (const offer of product.offers) offer.mode = 'live';
  }
  const first = boot.session.rounds.at(-1).products[0];
  boot.session.rounds.at(-1).products[1].imageUrl = 'https://images.seller-cdn.org/dead.png';
  const reports: Record<string, unknown>[] = [];
  await page.route('**/api/bootstrap', route => route.fulfill({ json: boot }));
  await page.route('**/api/image?*', route => route.fulfill({ status: 404 }));
  await page.route(`**/api/sessions/${boot.session.id}/products/*/image?*`, route => {
    if (route.request().url().includes(`/products/${first.id}/`)) {
      return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
    }
    return route.fulfill({ status: 404, json: { code: 'IMAGE_UNAVAILABLE' } });
  });
  await page.route('**/api/client-events', route => {
    reports.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  const card = page.getByTestId('product-card').filter({ has: page.getByRole('heading', { name: first.name, exact: true }) });
  const photo = card.getByRole('img');
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const failedCard = page.getByTestId('product-card').filter({ has: page.getByRole('heading', { name: boot.session.rounds.at(-1).products[1].name, exact: true }) });
  await failedCard.scrollIntoViewIfNeeded();
  await expect(failedCard.locator('.product-glyph')).toBeVisible();
  await expect.poll(() => reports.some(event => event.kind === 'image_unavailable')).toBe(true);
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++) window.dispatchEvent(new ErrorEvent('error', {
      error: new TypeError('secret chat text'), message: 'secret chat text',
      filename: `${location.origin}/assets/test.js?token=secret`, lineno: 12, colno: 3,
    }));
  });
  await expect.poll(() => reports.filter(event => event.kind === 'runtime_error').length).toBe(1);
  expect(reports.find(event => event.kind === 'runtime_error')).toEqual({ kind: 'runtime_error', errorType: 'TypeError', asset: '/assets/test.js', line: 12, column: 3 });
  expect(JSON.stringify(reports)).not.toContain('secret');
});

test('Ask → Configure → Discovery ↔ Learn → Buy persists across reload', { tag: '@mobile-smoke' }, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByText('Scripted preview', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Configure' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Your message' }).fill('I need a laptop for coding');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('log')).toContainText('which country');
  await page.getByRole('textbox', { name: 'Your message' }).fill('Italy, budget €700');
  await page.getByRole('textbox', { name: 'Your message' }).press('Enter');
  await expect(page.getByRole('button', { name: 'Continue to Configure' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue to Configure' }).click();
  // The step is persisted by an async PATCH; wait before reloading so the restored stage is Configure.
  await expect(page.getByRole('navigation', { name: 'Shopping steps' }).getByRole('button', { name: /Configure/ })).toHaveAttribute('aria-current', 'step');
  await page.reload();
  await expect(page.getByLabel('Budget ceiling')).toHaveValue('700');
  await page.getByLabel('My budget is a hard limit').check();
  await page.getByRole('button', { name: 'Find products' }).click();
  await expect(page.getByTestId('product-card')).toHaveCount(5);
  await page.getByText('Other discovered results (1)', { exact: true }).click();
  await expect(page.getByTestId('archived-product')).toHaveCount(1);
  await expect(page.getByTestId('archived-product')).toContainText('Excluded from current recommendations');
  const first = page.getByTestId('product-card').first();
  const firstName = await first.getByRole('heading').textContent();
  await first.getByRole('button', { name: 'Not for me' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply & search again' })).toBeDisabled();
  await page.getByRole('button', { name: 'Keep exploring' }).click();
  await expect(page.getByTestId('product-card')).toHaveCount(5);
  await first.getByRole('button', { name: 'Not for me' }).click();
  await page.getByLabel('Tell us a little more').fill('I need it to weigh less than 1.5 kg');
  await page.getByRole('button', { name: 'Apply & search again' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('product-card')).toHaveCount(4);
  await expect(page.getByTestId('product-card').filter({ has: page.getByRole('heading', { name: firstName!, exact: true }) })).toHaveCount(0);
  await expect(page.getByTestId('archived-product').filter({ has: page.getByRole('heading', { name: firstName!, exact: true }) })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('product-card')).toHaveCount(4);
  await expect(page.getByText('I need it to weigh less than 1.5 kg', { exact: true })).toBeVisible();
  await page.getByText('Other discovered results (2)', { exact: true }).click();
  await expect(page.getByTestId('archived-product').filter({ has: page.getByRole('heading', { name: firstName!, exact: true }) })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('product-card')).toHaveCount(5);
  await expect(page.getByTestId('archived-product')).toHaveCount(1);
  await page.getByTestId('product-card').first().getByRole('button', { name: 'Purchase options' }).click();
  await expect(page.getByText('Nothing has been purchased.', { exact: false })).toBeVisible();
  await expect(page.getByText('Fictional seller — no purchase link')).toHaveCount(2);
  await page.getByRole('button', { name: 'Back to discovery' }).click();
  await expect(page.getByTestId('product-card')).toHaveCount(5);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: 'New search' }).click();
  await expect(page.getByRole('log')).toContainText('What are you looking for?');
});

test('discovery shows the first product while searching and preserves partial results across reloads', async ({ page }) => {
  const boot = await discoveryBootstrap(page.request);
  const complete = structuredClone(boot.session);
  let current = structuredClone(complete);
  const round = current.rounds.at(-1);
  round.status = 'running'; round.finishedAt = null;
  round.products = round.products.slice(0, 1);
  round.ranking.ranked = round.ranking.ranked.filter((ranked: { offerId: string }) => round.products[0].offers.some((offer: { id: string }) => offer.id === ranked.offerId));
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...boot, session: current } }));
  await page.route(`**/api/sessions/${complete.id}`, route => route.fulfill({ json: current }));
  await page.goto('/');
  await expect(page.getByTestId('product-card')).toHaveCount(1);
  await expect(page.getByText('1 option ready to explore. More on the way.')).toBeVisible();
  await expect(page.getByText('Searching for at least 4 distinct products', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Purchase options' })).toBeDisabled();
  await page.getByLabel('Steer your results').fill('Include Moulinex products too');
  await expect(page.getByRole('button', { name: 'Update results' })).toBeDisabled();
  await page.getByText('Trade-offs & evidence', { exact: false }).click();
  await expect(page.getByText('Battery health is unknown; verify it with the seller.')).toBeVisible();
  await expect(page.getByText('No grounded matches this time.')).toHaveCount(0);
  current = structuredClone(complete); current.version++;
  current.rounds.at(-1).status = 'running'; current.rounds.at(-1).finishedAt = null;
  current.rounds.at(-1).products = current.rounds.at(-1).products.slice(0, 2);
  await expect(page.getByTestId('product-card')).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId('product-card')).toHaveCount(2);
  current = structuredClone(complete); current.version += 2;
  await expect(page.getByTestId('product-card')).toHaveCount(6);
  await expect(page.getByTestId('product-card').first().getByRole('button', { name: 'Purchase options' })).toBeEnabled();
  await expect(page.getByLabel('Steer your results')).toHaveValue('');

  // A later provider failure must not hide products that were already grounded.
  current.rounds.at(-1).status = 'failed'; current.rounds.at(-1).error = 'Later research failed.';
  current.rounds.at(-1).products = current.rounds.at(-1).products.slice(0, 1);
  await page.reload();
  await expect(page.getByTestId('product-card')).toHaveCount(1);
  await expect(page.getByRole('alert')).toContainText('Later research failed.');
});

test('discovery activity updates live and keeps its history across reloads and completion', { tag: '@mobile-smoke' }, async ({ page }) => {
  const boot = await discoveryBootstrap(page.request);
  const current = structuredClone(boot.session);
  const round = current.rounds.at(-1);
  round.status = 'running'; round.finishedAt = null; round.durationMs = null;
  round.activities = [{ message: 'Looking for product offers on shop.example.org via web search.', at: new Date().toISOString() }];
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...boot, session: current } }));
  await page.route(`**/api/sessions/${current.id}`, route => route.fulfill({ json: current }));
  await page.goto('/');
  const activity = page.getByRole('region', { name: 'Research activity', exact: true });
  await expect(activity.getByRole('status')).toHaveText(round.activities[0].message);
  round.activities.push({ message: 'Checking Aster 14 against your requirements and its source evidence.', at: new Date().toISOString() });
  current.version++;
  await expect(activity.getByRole('status')).toHaveText(round.activities[1].message);
  await page.reload();
  await expect(activity.getByRole('status')).toHaveText(round.activities[1].message);
  await activity.getByText('Recent research activity (2)', { exact: true }).click();
  await expect(activity.getByRole('listitem')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  round.status = 'complete'; current.version++;
  await expect(activity.getByRole('status')).toHaveCount(0);
  await expect(activity.getByText('Research activity (2)', { exact: true })).toBeVisible();
  await expect(activity.getByRole('listitem')).toHaveCount(2);
});

test('earlier products stay accessible during a fresh search and after failure', async ({ page }) => {
  const boot = await discoveryBootstrap(page.request);
  const session = structuredClone(boot.session);
  const next = structuredClone(session.rounds.at(-1));
  next.id = 'next-round'; next.number++; next.status = 'queued';
  next.products = []; next.ranking = null; next.summary = ''; next.finishedAt = null; next.durationMs = null;
  session.rounds.push(next);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...boot, session } }));
  await page.route(`**/api/sessions/${session.id}`, route => route.fulfill({ json: session }));
  await page.goto('/');
  await expect(page.getByTestId('product-card')).toHaveCount(0);
  await page.getByText('Other discovered results (6)', { exact: true }).click();
  await expect(page.getByTestId('archived-product')).toHaveCount(6);
  await expect(page.getByTestId('archived-product').first()).toBeVisible();
  await page.getByTestId('archived-product').first().getByText('Details & sources', { exact: true }).click();
  await expect(page.getByTestId('archived-product').first()).toContainText('Historical offer');
  next.status = 'failed'; next.error = 'Search interrupted.';
  await page.reload();
  await page.getByText('Other discovered results (6)', { exact: true }).click();
  await expect(page.getByTestId('archived-product')).toHaveCount(6);
  await expect(page.getByRole('alert')).toContainText('Search interrupted.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
});

test('configuration helper and unstructured requirements keep manual changes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Your message' }).fill('Laptop for coding in Italy, budget €700');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Continue to Configure' }).click();
  await page.getByLabel('Budget ceiling').fill('650');
  await page.getByLabel('Add a requirement').fill('A matte screen');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Additional requirements').fill('Keep my manually edited budget');
  await page.getByRole('button', { name: 'Update brief' }).click();
  await expect(page.getByLabel('Budget ceiling')).toHaveValue('650');
  await expect(page.getByText('A matte screen', { exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
});

test('discovery accepts steering requests and preserves drafts on failure', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Your message' }).fill('Laptop for coding in Italy, budget €700');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Continue to Configure' }).click();
  await page.getByRole('button', { name: 'Find products' }).click();
  const update = page.getByRole('button', { name: 'Update results' });
  const input = page.getByLabel('Steer your results');
  await expect(update).toBeDisabled();
  await input.fill('   ');
  await expect(update).toBeDisabled();
  await input.fill('Include Moulinex products too');
  await expect(update).toBeEnabled();
  await page.route('**/api/sessions/*/learn', route => route.fulfill({ status: 503, json: { error: 'Please try again.' } }));
  await update.click();
  await expect(page.getByRole('alert')).toContainText('Please try again.');
  await expect(input).toHaveValue('Include Moulinex products too');
  await page.unroute('**/api/sessions/*/learn');
  const request = page.waitForRequest(request => request.url().endsWith('/learn') && request.method() === 'POST');
  await update.click();
  expect((await request).postDataJSON()).toEqual({ productId: null, reason: 'Include Moulinex products too' });
  await expect(input).toHaveValue('');
  await expect(page.getByText('Include Moulinex products too', { exact: true })).toBeVisible();
  await expect(update).toBeDisabled();
  await page.reload();
  await expect(page.getByText('Include Moulinex products too', { exact: true })).toBeVisible();
  const boot = await (await page.request.get('/api/bootstrap')).json();
  expect(boot.session.rounds.at(-1).context.feedback.at(-1).reason).toBe('Include Moulinex products too');
  expect(boot.session.rounds.at(-1).context.config.budgetMax).toBe(700);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
});
