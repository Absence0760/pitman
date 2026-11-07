import { expect, test } from './fixtures.js';

test('the landing page renders a top-level heading', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
