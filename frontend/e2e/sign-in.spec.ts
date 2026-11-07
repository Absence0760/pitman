import { readFileSync } from 'node:fs';
import { ADMIN, expect, test, type Page } from './fixtures.js';
import { syntheticNetworkZip } from '../src/lib/network/synthetic.js';

// Sign-in (issue #28 P5, A-AUTH-1/2): the gate, the email then code steps, the errors, `next` and the open-redirect
// guard, a lapsed session from a data call, and sign out. The API is mocked with page.route; no real backend.

const fixture = JSON.parse(readFileSync(new URL('../../backend/fixtures/geo/quaternaries.synthetic.geojson', import.meta.url), 'utf8')) as { features: { properties: { code: string }; geometry: unknown }[] };
const QUATERNARIES = { type: 'FeatureCollection', source: 'Invented boundaries for the test', features: fixture.features.map((f) => ({ type: 'Feature', properties: { code: f.properties.code }, geometry: f.geometry })) };

const USER = { id: 'u-1', email: 'someone@example.test', isAdmin: false };

/** The sign-in API: a code is accepted for USER's address when it is `good`. Records each body. */
async function signInApi(page: Page, good = '123456') {
	const bodies: { path: string; body: unknown }[] = [];
	await page.route('**/api/auth/code', (route) => {
		bodies.push({ path: 'code', body: route.request().postDataJSON() });
		return route.fulfill({ status: 202, json: {} });
	});
	await page.route('**/api/auth/verify', (route) => {
		const body = route.request().postDataJSON() as { email: string; code: string };
		bodies.push({ path: 'verify', body });
		return body.code === good ? route.fulfill({ json: { user: USER } }) : route.fulfill({ status: 401, json: { error: 'That code is wrong or has expired.' } });
	});
	return bodies;
}

async function signIn(page: Page, code = '123456') {
	await page.getByLabel('Email address').fill(USER.email);
	await page.getByRole('button', { name: 'Send a code' }).click();
	await expect(page.getByLabel('Code from the email')).toBeFocused();
	await page.getByLabel('Code from the email').fill(code);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('signed out', () => {
	test.use({ signedInAs: null });

	test('the app sends a signed-out visitor to sign-in, and the code lands them in the app', async ({ page }) => {
		const bodies = await signInApi(page);
		await page.goto('/');
		await expect(page).toHaveURL(/\/sign-in$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
		await signIn(page);
		await expect(page).toHaveURL(/127\.0\.0\.1:8888\/$/);
		await expect(page.getByRole('heading', { name: 'Load a network' })).toBeVisible();
		const account = page.getByRole('navigation', { name: 'Account' });
		await expect(account).toContainText(USER.email);
		await expect(account.getByRole('link', { name: 'Users' })).toHaveCount(0);
		expect(bodies).toEqual([
			{ path: 'code', body: { email: USER.email } },
			{ path: 'verify', body: { email: USER.email, code: '123456' } }
		]);
	});

	test('the code box is made for a one-time code, and the answer never says who is listed', async ({ page }) => {
		await signInApi(page);
		await page.goto('/sign-in');
		await page.getByLabel('Email address').fill('stranger@example.test');
		await page.getByRole('button', { name: 'Send a code' }).click();
		const code = page.getByLabel('Code from the email');
		await expect(code).toBeFocused();
		await expect(code).toHaveAttribute('inputmode', 'numeric');
		await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
		await expect(page.getByText('If stranger@example.test is on Pitman’s list, a 6-digit code is on its way.')).toBeVisible();
	});

	test('a wrong code says so, keeps the focus on the code, and another address can be used', async ({ page }) => {
		await signInApi(page);
		await page.goto('/sign-in');
		await signIn(page, '000000');
		await expect(page.getByRole('alert')).toHaveText('That code is wrong or has expired.');
		await expect(page.getByLabel('Code from the email')).toBeFocused();
		await expect(page.getByLabel('Code from the email')).toHaveAttribute('aria-invalid', 'true');
		await expect(page).toHaveURL(/\/sign-in$/);

		await page.getByRole('button', { name: 'Use a different address' }).click();
		await expect(page.getByLabel('Email address')).toBeFocused();
		await expect(page.getByRole('alert')).toHaveText('');
	});

	test('a code that is not 6 digits is refused before it is sent', async ({ page }) => {
		const bodies = await signInApi(page);
		await page.goto('/sign-in');
		await signIn(page, '12ab');
		await expect(page.getByRole('alert')).toHaveText('The code is 6 digits, from the email.');
		expect(bodies.map((b) => b.path)).toEqual(['code']);
	});

	test('too many requests says how long to wait', async ({ page }) => {
		await page.route('**/api/auth/code', (route) => route.fulfill({ status: 429, headers: { 'retry-after': '120' }, json: { error: 'Too many requests.' } }));
		await page.goto('/sign-in');
		await page.getByLabel('Email address').fill(USER.email);
		await page.getByRole('button', { name: 'Send a code' }).click();
		await expect(page.getByRole('alert')).toHaveText('Too many tries. Wait about 2 minutes, then try again.');
		await expect(page.getByLabel('Email address')).toBeFocused();
	});

	test('a 400 shows the API’s own sentence', async ({ page }) => {
		await page.route('**/api/auth/code', (route) => route.fulfill({ status: 400, json: { error: 'That is not an email address.' } }));
		await page.goto('/sign-in');
		await page.getByLabel('Email address').fill('not-an-address');
		await page.getByRole('button', { name: 'Send a code' }).click();
		await expect(page.getByRole('alert')).toHaveText('That is not an email address.');
	});

	test('after signing in it goes back to the page in `next`', async ({ page }) => {
		await signInApi(page);
		await page.route('**/api/users', (route) => route.fulfill({ status: 403, json: { error: 'Only an admin can see the user list.' } }));
		await page.goto('/sign-in?next=%2Fusers');
		await signIn(page);
		await expect(page).toHaveURL(/127\.0\.0\.1:8888\/users$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
	});

	for (const next of ['//evil.example', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)']) {
		test(`next=${next} is refused: it lands at home, on this site`, async ({ page }) => {
			await signInApi(page);
			await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
			await signIn(page);
			await expect(page).toHaveURL('http://127.0.0.1:8888/');
			await expect(page.getByRole('heading', { name: 'Load a network' })).toBeVisible();
		});
	}

	test('the privacy notice and Methods open without signing in', async ({ page }) => {
		await page.goto('/sign-in');
		await page.getByRole('link', { name: 'Privacy' }).click();
		await expect(page).toHaveURL(/\/privacy$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
		await page.goto('/methods');
		await expect(page.getByRole('heading', { level: 1, name: 'Methods' })).toBeVisible();
		await expect(page).toHaveURL(/\/methods$/);
	});
});

test('a 401 from a data call goes to sign-in with the way back, and the working copy is still there after', async ({ page }) => {
	await page.route('**/quaternaries', (route) => route.fulfill({ json: QUATERNARIES }));
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip({ startYear: 1980, years: 30 })) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Account' })).toContainText(ADMIN.email);

	// The session lapses: the next data call answers 401.
	await page.route('**/api/cfm/land-use', (route) => route.fulfill({ status: 401, json: { error: 'Not signed in.' } }));
	await page.goto('/#landuse-h');
	const panel = page.getByRole('region', { name: 'Crop fields and farm dams' });
	await panel.scrollIntoViewIfNeeded();
	await panel.getByLabel('Quaternary', { exact: true }).selectOption('Z01A');
	await panel.getByRole('button', { name: 'Fetch the fields and dams' }).click();
	await expect(page).toHaveURL(/\/sign-in\?next=%2F%23landuse-h$/);

	await signInApi(page);
	await signIn(page);
	await expect(page).toHaveURL(/127\.0\.0\.1:8888\/#landuse-h$/);
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await expect(page.getByText('Restored from this browser’s working copy')).toBeVisible();
});

test('a lapsed session on the Users page comes back to it', async ({ page }) => {
	await page.route('**/api/users', (route) => route.fulfill({ status: 401, json: { error: 'Not signed in.' } }));
	await page.goto('/users');
	await expect(page).toHaveURL(/\/sign-in\?next=%2Fusers$/);
});

test('Sign out ends the session and goes to sign-in', async ({ page }) => {
	let out = 0;
	await page.route('**/api/auth/logout', (route) => {
		out++;
		return route.fulfill({ status: 204 });
	});
	await page.goto('/');
	const account = page.getByRole('navigation', { name: 'Account' });
	await expect(account).toContainText(ADMIN.email);
	await account.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page).toHaveURL(/\/sign-in$/);
	await expect(page.getByRole('navigation', { name: 'Account' })).toHaveCount(0);
	expect(out).toBe(1);
});
