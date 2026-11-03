import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AskQuestion, ChatMessage } from '@fairbuy/core';

const condition = {
  prompt: 'What condition are you open to?',
  options: [
    { id: 'new', label: 'New only' },
    { id: 'used', label: 'Used is fine' },
    { id: 'refurbished', label: 'Refurbished is fine' },
  ],
  multiSelect: false,
  allowFreeText: true,
};

const extras = {
  prompt: 'Which extras matter?',
  options: [
    { id: 'warranty', label: 'Two-year warranty' },
    { id: 'case', label: 'Carrying case' },
    { id: 'delivery', label: 'Delivery by Friday' },
  ],
  multiSelect: true,
  allowFreeText: true,
};

async function createSession(request: APIRequestContext) {
  const created = await request.post('/api/sessions', { headers: { 'X-Fairbuy-Request': '1' } });
  expect(created.status()).toBe(201);
  return created.json();
}

async function openQuestion(page: Page, question: AskQuestion = condition, failFirst = false) {
  const session = await createSession(page.request);
  const messages: ChatMessage[] = [{ role: 'assistant', content: 'One quick choice.', question }];
  const submitted: string[] = [];
  const boot = await (await page.request.get('/api/bootstrap')).json();
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...boot, session: { ...session, askMessages: messages } } }));
  await page.route(`**/api/sessions/${session.id}/ask`, async route => {
    const { message } = route.request().postDataJSON();
    submitted.push(message);
    if (failFirst && submitted.length === 1) {
      await route.fulfill({ status: 503, json: { error: 'Please retry your answer.' } });
      return;
    }
    messages.push({ role: 'user', content: message }, { role: 'assistant', content: 'Thanks, noted.' });
    await route.fulfill({ json: { ...session, askMessages: messages } });
  });
  await page.goto('/');
  const group = page.getByRole('group', { name: question.prompt });
  await expect(group).toBeVisible();
  return { submitted, group };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'geolocation', { value: {
    getCurrentPosition: (_success: unknown, failure: (error: { code: number }) => void) => failure({ code: 1 }),
  } }));
});

test('Ask renders single- and multi-select question cards and submits one concise answer', { tag: '@mobile-smoke' }, async ({ page }) => {
  const session = await createSession(page.request);
  const messages: ChatMessage[] = [{ role: 'assistant', content: 'One quick choice, then I have what I need.', question: condition }];
  const submitted: string[] = [];
  const boot = await (await page.request.get('/api/bootstrap')).json();
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...boot, session: { ...session, stage: 'ask', askMessages: messages } } }));
  await page.route(`**/api/sessions/${session.id}/ask`, async route => {
    const { message } = route.request().postDataJSON();
    submitted.push(message);
    messages.push({ role: 'user', content: message });
    if (submitted.length === 1) {
      messages.push({ role: 'assistant', content: 'Noted. Anything else that would make or break it?', question: extras });
    } else {
      messages.push({ role: 'assistant', content: 'Thanks — that is everything I need.' });
    }
    await route.fulfill({ json: { ...session, stage: 'ask', ready: true, askMessages: messages } });
  });
  await page.goto('/');

  const conditionGroup = page.getByRole('group', { name: condition.prompt });
  await expect(conditionGroup).toBeVisible();
  await expect(conditionGroup.getByRole('radio')).toHaveCount(3);
  await conditionGroup.getByRole('radio', { name: 'New only' }).check();
  await conditionGroup.getByLabel(/Other/).fill('must arrive by Friday');
  await conditionGroup.getByRole('button', { name: 'Send answer' }).click();

  await expect.poll(() => submitted).toEqual(['New only — must arrive by Friday']);
  await expect(page.getByRole('log')).toContainText('Noted. Anything else that would make or break it?');
  // The answered card remains in the transcript but cannot submit twice.
  await expect(conditionGroup.getByRole('radio', { name: 'New only' })).toBeDisabled();
  await expect(conditionGroup.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
  // Focus returns to the normal composer so a typed follow-up stays possible.
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeFocused();

  const extrasGroup = page.getByRole('group', { name: extras.prompt });
  await expect(extrasGroup).toBeVisible();
  await expect(extrasGroup.getByRole('checkbox')).toHaveCount(3);
  await extrasGroup.getByRole('checkbox', { name: 'Two-year warranty' }).check();
  await extrasGroup.getByRole('checkbox', { name: 'Delivery by Friday' }).check();
  await extrasGroup.getByRole('button', { name: 'Send answer' }).click();

  await expect.poll(() => submitted).toEqual(['New only — must arrive by Friday', 'Two-year warranty, Delivery by Friday']);
  await expect(page.getByRole('log')).toContainText('Thanks — that is everything I need.');
  await expect(page.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeFocused();

  // Re-render the mocked transcript on refresh; backend persistence is tested separately.
  await page.reload();
  await expect(page.getByRole('group', { name: condition.prompt })).toHaveCount(1);
  await expect(page.getByRole('group', { name: extras.prompt })).toHaveCount(1);
  await expect(page.getByRole('log')).toContainText('Two-year warranty, Delivery by Friday');
  await expect(page.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
});

test('Ask radio choices, Other and submit work with the keyboard', async ({ page }) => {
  const { submitted, group } = await openQuestion(page);
  const first = group.getByRole('radio', { name: 'New only' });
  const second = group.getByRole('radio', { name: 'Used is fine' });
  await first.focus();
  await page.keyboard.press('Space');
  await expect(first).toBeChecked();
  await page.keyboard.press('ArrowDown');
  await expect(second).toBeFocused();
  await expect(second).toBeChecked();
  await expect(first).not.toBeChecked();
  await page.keyboard.press('Tab');
  await expect(group.getByLabel(/Other/)).toBeFocused();
  await page.keyboard.type('with warranty');
  await page.keyboard.press('Tab');
  await expect(group.getByRole('button', { name: 'Send answer' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => submitted).toEqual(['Used is fine — with warranty']);
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeFocused();
});

test('Ask multi-select choices work with Tab and Space', async ({ page }) => {
  const { submitted, group } = await openQuestion(page, extras);
  const first = group.getByRole('checkbox', { name: 'Two-year warranty' });
  await first.focus();
  await page.keyboard.press('Space');
  await expect(first).toBeChecked();
  await page.keyboard.press('Tab');
  const second = group.getByRole('checkbox', { name: 'Carrying case' });
  await expect(second).toBeFocused();
  await page.keyboard.press('Space');
  await expect(second).toBeChecked();
  await page.keyboard.press('Tab'); // third checkbox, left unchecked
  await page.keyboard.press('Tab'); // Other
  await page.keyboard.press('Tab'); // submit
  await expect(group.getByRole('button', { name: 'Send answer' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => submitted).toEqual(['Two-year warranty, Carrying case']);
});

test('Ask accepts Other alone even when the question disables free text', async ({ page }) => {
  const { submitted, group } = await openQuestion(page, { ...condition, allowFreeText: false });
  await expect(group.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  await group.getByLabel(/Other/).fill('   Open box with warranty   ');
  await group.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => submitted).toEqual(['Open box with warranty']);
});

test('Ask lets users ignore a card and continue with text-only replies', async ({ page }) => {
  const { submitted, group } = await openQuestion(page);
  const composer = page.getByRole('textbox', { name: 'Your message' });
  await composer.fill('Actually, condition does not matter.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => submitted).toEqual(['Actually, condition does not matter.']);
  await expect(group.getByRole('radio').first()).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText('Thanks, noted.');
  await composer.fill('A plain follow-up');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => submitted).toEqual(['Actually, condition does not matter.', 'A plain follow-up']);
});

test('Ask preserves a failed card answer and allows retry without duplicating the transcript', async ({ page }) => {
  const { submitted, group } = await openQuestion(page, condition, true);
  await group.getByRole('radio', { name: 'New only' }).check();
  await group.getByLabel(/Other/).fill('with warranty');
  await group.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByRole('alert')).toContainText('Please retry your answer.');
  await expect(group.getByRole('radio', { name: 'New only' })).toBeChecked();
  await expect(group.getByLabel(/Other/)).toHaveValue('with warranty');
  await expect(group.getByRole('button', { name: 'Send answer' })).toBeEnabled();
  await group.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => submitted).toEqual(['New only — with warranty', 'New only — with warranty']);
  await expect(page.getByRole('log').getByText('New only — with warranty', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeFocused();
});
