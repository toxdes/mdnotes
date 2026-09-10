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
  await expect(page.locator('.note-item').filter({hasText: title})).toBeVisible();
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

test('keeps the typing caret and active preview block away from the viewport edge', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await expect(page.locator('#editor')).toBeVisible();

  const content = Array.from({length: 80}, (_, index) => `## Section ${index}\n\nA paragraph with enough text to create a useful rendered preview block.`).join('\n\n');
  const editor = page.locator('#note-content');
  await editor.fill(content);
  await editor.focus();
  await editor.press('End');
  await page.waitForTimeout(700);

  const metrics = await page.evaluate(() => {
    const textarea = document.querySelector('#note-content');
    const preview = document.querySelector('#preview');
    const active = preview.querySelector('.highlight');
    const previewRect = preview.getBoundingClientRect();
    const activeRect = active?.getBoundingClientRect();
    return {
      editorHasScrollRoom: textarea.scrollHeight > textarea.clientHeight,
      editorScrollTop: textarea.scrollTop,
      previewHasScrollRoom: preview.scrollHeight > preview.clientHeight,
      previewScrollTop: preview.scrollTop,
      activeVisible: Boolean(activeRect && activeRect.bottom > previewRect.top && activeRect.top < previewRect.bottom),
    };
  });

  expect(metrics.editorHasScrollRoom).toBe(true);
  expect(metrics.editorScrollTop).toBeGreaterThan(0);
  expect(metrics.previewHasScrollRoom).toBe(true);
  expect(metrics.previewScrollTop, JSON.stringify(metrics)).toBeGreaterThan(0);
  expect(metrics.activeVisible).toBe(true);
});
