import AxeBuilder from '@axe-core/playwright';
import {expect, test} from '@playwright/test';

const password = 'browser-test-password';

async function signIn(page) {
  await page.goto('/');
  await page.locator('#login-form input[name="password"]').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
}

test('dashboard and preferences have no serious accessibility violations', async ({page}) => {
  await signIn(page);

  const dashboardResults = await new AxeBuilder({page}).include('#dashboard').analyze();
  expect(dashboardResults.violations.filter(violation => ['critical', 'serious'].includes(violation.impact))).toEqual([]);

  await page.locator('#prefs-btn').click();
  const preferencesResults = await new AxeBuilder({page}).include('#prefs-modal').analyze();
  expect(preferencesResults.violations.filter(violation => ['critical', 'serious'].includes(violation.impact))).toEqual([]);
});

test('preferences can be opened, navigated, trapped, and closed from the keyboard', async ({page}) => {
  await signIn(page);

  await page.locator('#prefs-btn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#prefs-modal')).toBeVisible();
  await expect(page.locator('#prefs-modal')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#prefs-close')).toBeFocused();

  await page.locator('#prefs-tab-appearance').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#pref-font')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#prefs-tab-appearance')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('#prefs-modal')).toBeHidden();
  await expect(page.locator('#prefs-btn')).toBeFocused();
});

test('dashboard note actions are reachable as native controls', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#note-title').fill('Keyboard note');
  await page.locator('#note-content').fill('Keyboard content');
  await page.locator('#save-btn').click();
  await page.locator('#back-btn').click();

  const note = page.locator('.note-item').filter({hasText: 'Keyboard note'});
  await expect(note).toHaveAttribute('type', 'button');
  await note.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#editor')).toBeVisible();
});
