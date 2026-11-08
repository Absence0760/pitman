import { expect, test } from './fixtures.js';

// The page is prerendered, so its controls exist before the app's handlers do, and a file picked in that
// gap would be dropped without a word (the change event is not replayed). The pickers stay disabled until
// the app has hydrated, and <html data-hydrated> says when it has (routes/+layout.svelte).

test.describe('before the app has started', () => {
	test.use({ waitForHydration: false });

	test('the network pickers are disabled, so a pick cannot be lost, and the page says nothing is ready', async ({ page }) => {
		await page.route('**/_app/immutable/**/*.js', (route) => route.abort());
		await page.goto('/');
		await expect(page.getByLabel('Network zip', { exact: true })).toBeDisabled();
		await expect(page.getByLabel('Network folder', { exact: true })).toBeDisabled();
		await expect(page.locator('html')).not.toHaveAttribute('data-hydrated');
	});
});

test('once the app has started, the pickers are enabled and the page says so', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	await expect(page.getByLabel('Network zip', { exact: true })).toBeEnabled();
	await expect(page.getByLabel('Network folder', { exact: true })).toBeEnabled();
});
