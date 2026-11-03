import { expect, test } from '@playwright/test';

test('an actual failed image request and browser report appear under the same backoffice trace', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
  const headers = { 'X-Fairbuy-Request': '1' };
  const created = await page.request.post('/api/sessions', { headers }); const session = await created.json();
  await page.request.post(`/api/sessions/${session.id}/ask`, { headers, data: { message: 'Laptop for coding in Italy' } });
  await page.request.post(`/api/sessions/${session.id}/discovery`, { headers });
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${session.id}`)).json()).rounds.at(-1)?.status).toBe('complete');
  const boot = await (await page.request.get('/api/bootstrap')).json();
  const product = boot.session.rounds.at(-1).products[0];
  // Render the recovery path while keeping backend fixture sources unchanged:
  // this exercises the real endpoints, never external websites or paid APIs.
  for (const p of boot.session.rounds.at(-1).products) for (const offer of p.offers) offer.mode = 'live';
  await page.route('**/api/bootstrap', route => route.fulfill({ json: boot }));
  const report = page.waitForRequest(request => request.url().endsWith('/api/client-events')
    && request.postDataJSON()?.kind === 'image_unavailable' && request.postDataJSON()?.productId === product.id);
  await page.goto('/');
  await expect(page.getByTestId('product-card').first().locator('.product-glyph')).toBeVisible();
  const { traceId } = (await report).postDataJSON();
  expect(traceId).toMatch(/^[\da-f-]{36}$/);
  expect((await page.request.post('/api/admin/login', { headers, data: { username: 'TestAdmin', password: 'e2e-only-password' } })).status()).toBe(200);
  await expect.poll(async () => {
    const result = await (await page.request.get(`/api/admin/diagnostics?traceId=${traceId}`)).json();
    return result.events.some((event: { event: string }) => event.event === 'client.image_unavailable');
  }).toBe(true);
  await page.goto('/backoffice/');
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await page.getByLabel('Trace ID', { exact: true }).fill(traceId);
  await page.getByRole('button', { name: 'Filter diagnostics', exact: true }).click();
  await expect(page.locator('#diagnostic-rows')).toContainText('image.request.started');
  await expect(page.locator('#diagnostic-rows')).toContainText('image.request.completed');
  await expect(page.locator('#diagnostic-rows')).toContainText('client.image_unavailable');
  const result = await (await page.request.get(`/api/admin/diagnostics?traceId=${traceId}`)).json();
  expect(result.events.every((event: { traceId: string; sessionId: string; productId: string }) => event.traceId === traceId && event.sessionId === session.id && event.productId === product.id)).toBe(true);
  expect(new Set(result.events.map((event: { source: string }) => event.source))).toEqual(new Set(['browser', 'server']));
});

test('admin can find a persisted browser error by trace and search, and session purge removes it', async ({ page }) => {
  const headers = { 'X-Fairbuy-Request': '1' };
  const created = await page.request.post('/api/sessions', { headers });
  expect(created.status()).toBe(201);
  const session = await created.json();
  const traceId = '8bc989e3-8bcc-478d-a274-45ba6fcd11ba';
  expect((await page.request.post('/api/client-events', { headers, data: {
    kind: 'runtime_error', traceId, sessionId: session.id, errorType: 'TypeError', asset: '/assets/test.js', line: 10, column: 4,
  } })).status()).toBe(204);
  expect((await page.request.get('/api/admin/diagnostics')).status()).toBe(401);
  await page.goto('/backoffice/');
  await page.getByLabel('Username', { exact: true }).fill('TestAdmin');
  await page.getByLabel('Password', { exact: true }).fill('e2e-only-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session history' })).toBeVisible();
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Error diagnostics' })).toBeVisible();
  await expect(page.locator('#diagnostics-policy')).toContainText('Retention managed externally');
  await expect(page.locator('#diagnostics-policy')).toContainText('Ephemeral demo memory only');
  await page.getByLabel('Trace ID', { exact: true }).fill(traceId);
  await page.getByRole('button', { name: 'Filter diagnostics', exact: true }).click();
  await expect(page.locator('#diagnostic-rows tr')).toHaveCount(1);
  await expect(page.locator('#diagnostic-rows')).toContainText('client.runtime_error');
  await expect(page.locator('#diagnostic-rows')).toContainText('TypeError');
  await expect(page.locator('#diagnostic-rows')).toContainText(session.id);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('combobox', { name: 'Origin', exact: true }).selectOption('server');
  await page.getByRole('button', { name: 'Filter diagnostics', exact: true }).click();
  await expect(page.locator('#diagnostic-rows')).toContainText('No diagnostic events match');
  await page.getByRole('combobox', { name: 'Origin', exact: true }).selectOption('browser');
  await page.getByRole('button', { name: 'Filter diagnostics', exact: true }).click();
  await expect(page.locator('#diagnostic-rows')).toContainText('client.runtime_error');
  await page.getByRole('button', { name: traceId, exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Origin', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: `Search ${session.id}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Usage by phase' })).toBeVisible();
  await page.getByRole('button', { name: 'View diagnostics for this search', exact: true }).click();
  await expect(page.getByLabel('Search ID', { exact: true })).toHaveValue(session.id);
  await expect(page.locator('#diagnostic-rows')).toContainText('client.runtime_error');
  expect((await page.request.post(`/api/admin/sessions/${session.id}/purge`, { headers, data: { confirmSessionId: session.id } })).status()).toBe(204);
  await page.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
  await expect(page.locator('#diagnostic-rows')).toContainText('No diagnostic events match');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.locator('#diagnostic-rows')).toBeEmpty();
});
