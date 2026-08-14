import {expect, test} from '@playwright/test';

const password = 'browser-test-password';

async function signIn(page) {
  await page.goto('/');
  await page.locator('#login-form input[name="password"]').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.evaluate(async () => {
    if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller))).toBe(true);
}

async function createNote(page, title = `Browser test ${Date.now()}`) {
  await page.locator('#new-note-btn').click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#note-title').fill(title);
  await page.locator('#note-content').fill('Durable browser test content');
  await page.locator('#save-btn').click();
  await page.locator('#back-btn').click();
  await expect(page.locator('.note-item').filter({hasText: title})).toBeVisible();
  return title;
}

test('restores a cached note when sync APIs are unavailable', async ({page}) => {
  await signIn(page);
  const title = await createNote(page);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller))).toBe(true);
  await page.route('**/api/**', route => route.abort());
  await page.reload({waitUntil: 'domcontentloaded'});

  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('.note-item')).toContainText(title);
  await expect(page.locator('#dashboard .offline-notice-message')).toContainText('Changes are saved on this device');
});

test('does not issue sync requests for unchanged dashboard navigation', async ({page}) => {
  await signIn(page);
  await createNote(page);
  await page.waitForTimeout(1500);
  const syncRequests = [];
  const recordSync = request => {
    if (new URL(request.url()).pathname.startsWith('/api/sync')) syncRequests.push(request.url());
  };
  page.on('request', recordSync);

  await page.locator('.note-item').first().click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#back-btn').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.waitForTimeout(500);

  expect(syncRequests).toEqual([]);
});

test('keeps warm dashboard display within the local startup budget', async ({page}) => {
  await signIn(page);
  const context = page.context();
  await page.close();
  const samples = [];
  for (let iteration = 0; iteration < 3; iteration++) {
    const samplePage = await context.newPage();
    await samplePage.route('**/api/**', route => route.abort());
    const started = Date.now();
    await samplePage.goto('/', {waitUntil: 'domcontentloaded'});
    await expect(samplePage.locator('#dashboard')).toBeVisible();
    samples.push(Date.now() - started);
    await samplePage.close();
  }

  samples.sort((left, right) => left - right);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  const budget = Number(process.env.WARM_DASHBOARD_BUDGET_MS || 1500);
  expect(p95, `warm dashboard samples: ${samples.join(', ')}`).toBeLessThan(budget);
});
