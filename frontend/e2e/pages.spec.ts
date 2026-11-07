import { readFileSync } from 'node:fs';
import { ADMIN, expect, test, type Page } from './fixtures.js';

// The sign-in, Users and Privacy pages (issue #28 P5–P6): the privacy notice's content, and the same access checks
// a11y.spec.ts makes on the app (one h1, no skipped level, names, 24 px targets, reflow) plus the CSP, on each.
test.use({ timezoneId: 'Africa/Johannesburg' });

// infra/csp.json's header, which vite preview doesn't send (as map.spec.ts).
const csp = (JSON.parse(readFileSync(new URL('../../infra/csp.json', import.meta.url), 'utf8')) as { site: string[][] }).site
	.filter(([name]) => name !== 'upgrade-insecure-requests')
	.map((d) => d.join(' '))
	.join('; ');

async function withCsp(page: Page) {
	await page.route(/127\.0\.0\.1:8888\/(sign-in|privacy|users)?$/, async (route) => {
		if (route.request().resourceType() !== 'document') return route.fallback();
		const response = await route.fetch();
		await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
	});
}

async function usersApi(page: Page) {
	await page.route('**/api/users', (route) => route.fulfill({ json: { users: [{ ...ADMIN, addedBy: 'operator', addedAt: '2026-11-07T08:00:00Z' }] } }));
	await page.route('**/api/audit?*', (route) => route.fulfill({ json: { rows: [{ at: '2026-11-07T08:00:00Z', actor: 'operator', action: 'bootstrap', target: ADMIN.email }] } }));
}

test.describe('the privacy notice, signed out', () => {
	test.use({ signedInAs: null });

	test('says who, what, why, where, how long and the rights, and stays put', async ({ page }) => {
		await page.goto('/privacy');
		await expect(page).toHaveTitle(/^Privacy/);
		await expect(page).toHaveURL(/\/privacy$/);
		for (const name of ['Who is responsible', 'What is kept', 'Why', 'Where', 'How long', 'Your rights']) {
			await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
		}
		await expect(page.getByText('Jared Howard', { exact: true })).toBeVisible();
		await expect(page.getByText(/Cape Town region \(af-south-1\)/)).toBeVisible();
		await expect(page.getByText('Your network files never leave your browser.', { exact: true })).toBeVisible();
		await expect(page.getByText(/About 24 months/)).toBeVisible();
		await expect(page.getByText(/restored for 35 days/)).toBeVisible();
		await expect(page.getByRole('link', { name: 'POPIAComplaints@inforegulator.org.za' })).toHaveAttribute('href', 'mailto:POPIAComplaints@inforegulator.org.za');
	});
});

test('the app’s footer links the privacy notice', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
});

const PAGES = [
	{ path: '/sign-in', signedIn: false },
	{ path: '/privacy', signedIn: false },
	{ path: '/users', signedIn: true }
] as const;

for (const { path, signedIn } of PAGES) {
	test.describe(path, () => {
		test.use({ signedInAs: signedIn ? ADMIN : null });

		test(`${path}: one h1, no level skipped, every control named and 24 px, no repeated id`, async ({ page }) => {
			await usersApi(page);
			await page.setViewportSize({ width: 1440, height: 960 });
			await page.goto(path);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			if (path === '/users') await expect(page.getByRole('table', { name: 'Audit log' })).toBeVisible();
			const problems = await page.evaluate(() => {
				const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
				const say = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
				const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible).map((e) => Number(e.tagName[1]));
				const named = (el: Element) => {
					const field = el as HTMLInputElement;
					return Boolean(el.getAttribute('aria-label') || field.labels?.[0]?.textContent?.trim() || (['BUTTON', 'A'].includes(el.tagName) && el.textContent?.trim()));
				};
				const controls = [...document.querySelectorAll('main button, main a[href], main input, header button, nav a')].filter(visible);
				const targets = controls.filter((el) => !(el.tagName === 'A' && el.closest('p,dd,li:not(nav li)')));
				const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
				return {
					h1: levels.filter((l) => l === 1).length,
					skips: levels.filter((l, i) => i > 0 && l > levels[i - 1]! + 1).length,
					unnamed: controls.filter((el) => !named(el)).map(say),
					small: targets.filter((el) => {
						const label = (el as HTMLInputElement).labels?.[0];
						const a = (el.matches('[type=checkbox]') && label ? label : el).getBoundingClientRect();
						return a.width < 24 || a.height < 24;
					}).map(say),
					repeated: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
				};
			});
			expect(problems).toEqual({ h1: 1, skips: 0, unnamed: [], small: [], repeated: [] });
		});

		for (const [width, height] of [[390, 844], [320, 800]] as const) {
			test(`${path}: reflows at ${width} px`, async ({ page }) => {
				await usersApi(page);
				await page.setViewportSize({ width, height });
				await page.goto(path);
				await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
				if (path === '/users') await expect(page.getByRole('table', { name: 'Audit log' })).toBeVisible();
				expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
			});
		}

		test(`${path}: loads under the content security policy, with no inline style`, async ({ page }) => {
			const blocked: string[] = [];
			page.on('console', (m) => {
				if (/content security policy/i.test(m.text())) blocked.push(m.text());
			});
			await usersApi(page);
			await withCsp(page);
			await page.goto(path);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			if (path === '/users') await expect(page.getByRole('table', { name: 'Audit log' })).toBeVisible();
			expect(blocked).toEqual([]);
			expect(await page.locator('main [style]').count()).toBe(0);
		});
	});
}
