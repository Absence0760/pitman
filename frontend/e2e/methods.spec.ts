import { expect, test } from '@playwright/test';

// The Methods page: static, one title, the features matrix, what isn't modelled said
// in words, the attribution, and no sideways scroll on a phone.

test('one title, the contents and each section', async ({ page }) => {
	await page.goto('/methods');
	await expect(page).toHaveTitle(/^Methods/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Methods');
	const contents = page.getByRole('navigation', { name: 'On this page' }).getByRole('link');
	await expect(contents).toHaveCount(7);
	await contents.filter({ hasText: 'What is modelled' }).click();
	await expect(page).toHaveURL(/#features$/);
	await expect(page.getByRole('heading', { name: 'What is modelled and what isn’t' })).toBeInViewport();
});

test('the matrix says what isn’t modelled, in words', async ({ page }) => {
	await page.goto('/methods');
	const matrix = page.getByRole('table', { name: 'Supported features' });
	await expect(matrix).toBeVisible();
	await expect(matrix.getByRole('row', { name: /Hughes groundwater/ })).toContainText('Not yet');
	await expect(matrix.getByRole('row', { name: /Irrigation \(RR\)/ })).toContainText('Partly');
	await expect(matrix.getByRole('row', { name: /Mines \(MM\)/ })).toContainText('Not yet');
	await expect(matrix.getByRole('row', { name: /Sami groundwater/ })).toContainText('Partly');
});

test('it warns before it claims, and credits its data', async ({ page }) => {
	await page.goto('/methods');
	await expect(page.getByText('doesn’t yet reproduce WRSM2000')).toBeVisible();
	await expect(page.getByRole('table', { name: /Comparison with WRSM2000/ })).toBeVisible();
	await expect(page.getByText('https://doi.org/10.15780/G2JQ0P')).toBeVisible();
	await expect(page.getByText('© Protomaps © OpenStreetMap contributors')).toBeVisible();
	await expect(page.getByText(/Copernicus WorldDEM-30 © DLR/)).toBeVisible();
});

test('no sideways scroll on a phone', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/methods');
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test('it loads under the content security policy, with no inline style', async ({ page }) => {
	const blocked: string[] = [];
	page.on('console', (m) => {
		if (/content security policy/i.test(m.text())) blocked.push(m.text());
	});
	await page.goto('/methods');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	expect(blocked).toEqual([]);
	expect(await page.locator('main [style]').count()).toBe(0);
});

test('Back goes to the app', async ({ page }) => {
	await page.goto('/methods');
	await page.getByRole('link', { name: 'Back to Pitman' }).click();
	await expect(page.getByRole('heading', { name: 'Load a network' })).toBeVisible();
});
