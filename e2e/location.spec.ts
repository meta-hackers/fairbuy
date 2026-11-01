import { test, expect } from '@playwright/test';

test('requests location on arrival, seeds Ask and preserves edited locations across reload', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 47.3769, longitude: 8.5417 });
  let lookups = 0;
  await page.route('**/api/location/reverse', async route => {
    lookups++;
    expect(route.request().postDataJSON()).toEqual({ latitude: 47.38, longitude: 8.54 });
    await route.fulfill({ json: { country: 'CH', city: 'Zurich', currency: 'CHF' } });
  });
  await page.goto('/');
  const location = page.getByRole('region', { name: 'Shopping location' });
  await expect(location).toContainText('Shopping in Zurich, Switzerland · CHF');
  expect(lookups).toBe(1);
  await page.getByRole('textbox', { name: 'Your message' }).fill('A laptop for coding');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Continue to Configure' }).click();
  await expect(page.getByLabel(/^Country code/)).toHaveValue('CH');
  await expect(page.getByLabel('City / region')).toHaveValue('Zurich');
  await expect(page.getByRole('combobox', { name: 'Currency', exact: true })).toHaveValue('CHF');
  await page.getByLabel('Budget ceiling').fill('800');
  await location.getByRole('button', { name: 'Change location' }).click();
  await page.getByLabel('Shopping country code').fill('GB');
  await expect(page.getByLabel('Shopping city')).toHaveValue('');
  await expect(page.getByLabel('Shopping currency')).toHaveValue('GBP');
  await page.getByLabel('Shopping city').fill('London');
  await location.getByRole('button', { name: 'Save location' }).click();
  await expect(page.getByLabel('Budget ceiling')).toHaveValue('800');
  await page.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('USD');
  await page.getByRole('navigation', { name: 'Shopping steps' }).getByRole('button', { name: /Ask/ }).click();
  // Navigate() persists the stage with an async PATCH and only then renders the
  // Ask view, so waiting for the composer guarantees the stored stage is 'ask'.
  // Reloading straight after the click races that request and restores Configure.
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeVisible();
  await page.reload();
  await expect(location).toContainText('Shopping in London, United Kingdom · USD');
  await page.getByRole('button', { name: 'Continue to Configure' }).click();
  await expect(page.getByLabel(/^Country code/)).toHaveValue('GB');
  await expect(page.getByRole('combobox', { name: 'Currency', exact: true })).toHaveValue('USD');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
});

test('denied permission leaves manual country, city and currency available before chatting', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'geolocation', { value: {
    getCurrentPosition: (_success: unknown, failure: (error: { code: number }) => void) => failure({ code: 1 }),
  } }));
  await page.goto('/');
  const location = page.getByRole('region', { name: 'Shopping location' });
  await expect(location).toContainText('Location access was denied');
  await location.getByRole('button', { name: 'Set location' }).click();
  await page.getByLabel('Shopping country code').fill('IT');
  await page.getByLabel('Shopping city').fill('Milan');
  await expect(page.getByLabel('Shopping currency')).toHaveValue('EUR');
  await location.getByRole('button', { name: 'Save location' }).click();
  await expect(location).toContainText('Shopping in Milan, Italy · EUR');
  await page.getByRole('textbox', { name: 'Your message' }).fill('A laptop for coding');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Continue to Configure' }).click();
  await expect(page.getByLabel(/^Country code/)).toHaveValue('IT');
  await expect(page.getByLabel('City / region')).toHaveValue('Milan');
});

test('a late location result never replaces a manual selection', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 47.38, longitude: 8.54 });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/location/reverse', async route => {
    started(); await waiting;
    await route.fulfill({ json: { country: 'CH', city: 'Zurich', currency: 'CHF' } });
  });
  await page.goto('/'); await requested;
  const location = page.getByRole('region', { name: 'Shopping location' });
  await location.getByRole('button', { name: 'Set location' }).click();
  await page.getByLabel('Shopping country code').fill('GB');
  await page.getByLabel('Shopping city').fill('London');
  await location.getByRole('button', { name: 'Save location' }).click();
  release();
  await expect(location).toContainText('Shopping in London, United Kingdom · GBP');
  await page.getByRole('textbox', { name: 'Your message' }).fill('A laptop for coding');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Continue to Configure' }).click();
  await expect(page.getByLabel(/^Country code/)).toHaveValue('GB');
  await expect(page.getByRole('combobox', { name: 'Currency', exact: true })).toHaveValue('GBP');
});

test('a late detected location fills an existing Ask brief before the next message', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 47.38, longitude: 8.54 });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/location/reverse', async route => {
    await waiting; await route.fulfill({ json: { country: 'CH', city: 'Zurich', currency: 'CHF' } });
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Your message' }).fill('A laptop for coding');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('log')).toContainText('which country');
  const saved = page.waitForResponse(response => /\/api\/sessions\/[^/]+\/location$/.test(response.url()) && response.status() === 200);
  release(); await saved;
  const brief = await page.request.get('/api/bootstrap');
  expect((await brief.json()).session.config).toMatchObject({ country: 'CH', city: 'Zurich', currency: 'CHF' });
  await page.getByRole('textbox', { name: 'Your message' }).fill('My budget is 800');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Continue to Configure' })).toBeEnabled();
});

test('geocoder failure does not block chatting or manual setup', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 47.38, longitude: 8.54 });
  await page.route('**/api/location/reverse', route => route.fulfill({ status: 503, json: { error: 'Could not determine your city and country. Set your location manually.' } }));
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Shopping location' })).toContainText('Could not determine your city and country');
  await page.getByRole('textbox', { name: 'Your message' }).fill('A laptop for coding in Italy');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Continue to Configure' })).toBeEnabled();
});

test('an unsupported local currency requires a manual choice instead of assuming EUR', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 51.18, longitude: -115.57 });
  await page.route('**/api/location/reverse', route => route.fulfill({ json: { country: 'CA', city: 'Banff', currency: null } }));
  await page.goto('/');
  const location = page.getByRole('region', { name: 'Shopping location' });
  await expect(location).toContainText('Shopping in Banff, Canada · choose currency');
  await expect(location).toContainText('local currency is not supported');
  await location.getByRole('button', { name: 'Change location' }).click();
  await page.getByLabel('Shopping currency').selectOption('USD');
  await location.getByRole('button', { name: 'Save location' }).click();
  await page.getByRole('textbox', { name: 'Your message' }).fill('A laptop for coding');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Continue to Configure' }).click();
  await expect(page.getByLabel(/^Country code/)).toHaveValue('CA');
  await expect(page.getByRole('combobox', { name: 'Currency', exact: true })).toHaveValue('USD');
});

test('unsupported geolocation still allows shopping', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'geolocation', { value: undefined }));
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Shopping location' })).toContainText('does not support location detection');
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeEnabled();
});

test('an unanswered permission prompt times out without blocking the page', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition() {} } }));
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Shopping location' })).toContainText('Finding your location');
  await page.clock.fastForward(12000);
  await expect(page.getByRole('region', { name: 'Shopping location' })).toContainText('Location detection timed out');
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeEnabled();
});
