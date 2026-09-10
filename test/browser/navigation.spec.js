import {expect, test} from '@playwright/test';

const password = 'browser-test-password';

async function signIn(page) {
  await page.goto('/');
  await page.locator('#login-form input[name="password"]').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
}

test('in-app Back does not leave a stale note in browser history', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('History test note');
  await page.locator('#note-content').fill('History test content');
  await page.locator('#save-btn').click();
  await page.locator('#back-btn').click();
  await expect(page.locator('#dashboard')).toBeVisible();

  await page.locator('.note-item').filter({hasText: 'History test note'}).click();
  await expect(page.locator('#editor')).toBeVisible();
  const noteURL = page.url();
  await page.locator('#back-btn').evaluate(button => {
    button.click();
    button.click();
  });
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => page.evaluate(() => history.state)).toMatchObject({app: 'mdnotes', screen: 'dashboard'});

  await page.goBack();
  expect(page.url()).not.toBe(noteURL);
});

test('browser Back saves the current note before returning to the dashboard', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Browser Back save test');
  await page.locator('#note-content').fill('Saved before browser navigation');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
  const noteURL = page.url();

  await page.locator('#note-content').fill('Saved before browser navigation and Back');
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#dashboard')).toBeVisible();

  await page.locator('.note-item').filter({hasText: 'Browser Back save test'}).click();
  await expect(page).toHaveURL(noteURL);
  await expect(page.locator('#note-content')).toHaveValue('Saved before browser navigation and Back');
});

test('direct note URLs get one dashboard history parent', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Deep link history test');
  await page.locator('#note-content').fill('Deep link content');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
  const noteURL = page.url();
  await page.locator('#back-btn').click();
  await expect(page.locator('#dashboard')).toBeVisible();

  await page.goto(noteURL);
  await expect(page.locator('#editor')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#dashboard')).toBeVisible();
});

test('editor preferences are available after Save', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Editor preferences test');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);

  const editorActions = page.locator('#editor header .header-right button');
  await expect(editorActions).toHaveCount(2);
  await expect(page.locator('#editor-prefs-btn')).toBeVisible();
  await page.locator('#editor-prefs-btn').click();
  await expect(page.locator('#prefs-modal')).toBeVisible();
});

test('browser Back closes Preferences and restores the note', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Preferences history test');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
  const noteURL = page.url();

  await page.locator('#editor-prefs-btn').click();
  await expect(page.locator('#prefs-modal')).toBeVisible();
  await expect(page).toHaveURL(/\/preferences$/);

  await page.goBack();
  await expect(page).toHaveURL(noteURL);
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#prefs-modal')).toBeHidden();

  await page.goForward();
  await expect(page).toHaveURL(/\/preferences$/);
  await expect(page.locator('#prefs-modal')).toBeVisible();
});

test('direct Preferences URL opens over the dashboard', async ({page}) => {
  await signIn(page);
  await page.goto('/preferences');
  await expect(page).toHaveURL(/\/preferences$/);
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#prefs-modal')).toBeVisible();
});
