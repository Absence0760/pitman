import { ADMIN, expect, MEMBER, test, type Page } from './fixtures.js';

// The Users page (issue #28 P5, A-AUTH-4): list, add, make and remove admin, remove with a confirmation, the API's
// refusals shown as they come, and the audit log in readable dates. A stateful mock of /api/users and /api/audit.
test.use({ timezoneId: 'Africa/Johannesburg' });

interface Row {
	id: string;
	email: string;
	isAdmin: boolean;
	addedBy: string;
	addedAt: string;
	undeliverable: { kind: 'bounce' | 'complaint'; at: string } | null;
}

async function usersApi(page: Page, refuse: { patch?: { status: number; error: string } } = {}, problem: Row['undeliverable'] = null) {
	const users: Row[] = [
		{ ...ADMIN, addedBy: 'operator', addedAt: '2026-11-07T08:00:00Z', undeliverable: null },
		{ ...MEMBER, addedBy: ADMIN.email, addedAt: '2026-11-07T09:30:00Z', undeliverable: problem }
	];
	const audit = [
		{ at: '2026-11-07T10:05:00Z', actor: ADMIN.email, action: 'signin', target: null },
		{ at: '2026-11-07T09:30:00Z', actor: ADMIN.email, action: 'add', target: MEMBER.email, admin: false },
		{ at: '2026-11-07T08:00:00Z', actor: 'operator', action: 'bootstrap', target: ADMIN.email }
	];
	const calls: string[] = [];
	await page.route('**/api/users', async (route) => {
		const req = route.request();
		calls.push(`${req.method()} /users`);
		if (req.method() === 'GET') return route.fulfill({ json: { users } });
		const body = req.postDataJSON() as { email: string; isAdmin?: boolean };
		if (users.some((u) => u.email === body.email)) return route.fulfill({ status: 409, json: { error: `${body.email} is already on the list.` } });
		const user = { id: `u-${users.length + 1}`, email: body.email, isAdmin: body.isAdmin === true };
		users.push({ ...user, addedBy: ADMIN.email, addedAt: '2026-11-07T11:00:00Z', undeliverable: null });
		return route.fulfill({ status: 201, json: { user } });
	});
	await page.route('**/api/users/*', async (route) => {
		const req = route.request();
		const id = decodeURIComponent(new URL(req.url()).pathname.split('/').pop()!);
		calls.push(`${req.method()} /users/${id}`);
		const user = users.find((u) => u.id === id);
		if (!user) return route.fulfill({ status: 404, json: { error: 'No such user.' } });
		if (req.method() === 'PATCH') {
			if (refuse.patch) return route.fulfill({ status: refuse.patch.status, json: { error: refuse.patch.error } });
			user.isAdmin = (req.postDataJSON() as { isAdmin: boolean }).isAdmin;
			return route.fulfill({ json: { user } });
		}
		users.splice(users.indexOf(user), 1);
		return route.fulfill({ status: 204 });
	});
	await page.route('**/api/users/*/clear-delivery-problem', async (route) => {
		const req = route.request();
		const id = decodeURIComponent(new URL(req.url()).pathname.split('/').at(-2)!);
		calls.push(`${req.method()} /users/${id}/clear-delivery-problem ${req.postData()}`);
		const user = users.find((u) => u.id === id)!;
		user.undeliverable = null;
		return route.fulfill({ json: { user } });
	});
	await page.route('**/api/audit?*', (route) => route.fulfill({ json: { rows: audit } }));
	return { users, calls };
}

const row = (page: Page, email: string) => page.getByRole('table', { name: /Users/ }).getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${email}`) }) });

test('an admin adds someone, makes them an admin and removes them, asked first', async ({ page }) => {
	const api = await usersApi(page);
	await page.goto('/');
	await page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Users' }).click();
	await expect(page).toHaveURL(/\/users$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
	await expect(row(page, ADMIN.email)).toContainText('(you)');
	await expect(row(page, MEMBER.email)).toContainText('User');

	await page.getByLabel('Email address').fill('new@example.test');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText('Added new@example.test. They can sign in now.');
	await expect(row(page, 'new@example.test')).toContainText('User');
	await expect(page.getByLabel('Email address')).toHaveValue('');

	await row(page, 'new@example.test').getByRole('button', { name: 'Make admin for new@example.test' }).click();
	await expect(row(page, 'new@example.test')).toContainText('Admin');
	await expect(page.getByRole('status')).toHaveText('new@example.test is now an admin.');

	await row(page, 'new@example.test').getByRole('button', { name: 'Remove new@example.test' }).click();
	const keep = row(page, 'new@example.test').getByRole('button', { name: 'Keep' });
	await expect(keep).toBeFocused();
	await keep.click();
	await expect(row(page, 'new@example.test').getByRole('button', { name: 'Remove new@example.test' })).toBeFocused();
	await row(page, 'new@example.test').getByRole('button', { name: 'Remove new@example.test' }).click();
	await row(page, 'new@example.test').getByRole('button', { name: 'Remove', exact: true }).click();
	await expect(row(page, 'new@example.test')).toHaveCount(0);
	await expect(page.getByRole('status')).toHaveText('Removed new@example.test. They are signed out and can’t sign in again.');
	expect(api.calls.filter((c) => c !== 'GET /users')).toEqual(['POST /users', 'PATCH /users/u-3', 'DELETE /users/u-3']);
});

test('the API’s refusals are shown as they come: 409 on a repeat add, 409 on the last admin', async ({ page }) => {
	await usersApi(page, { patch: { status: 409, error: 'Pitman needs at least one admin.' } });
	await page.goto('/users');
	await page.getByLabel('Email address').fill(MEMBER.email);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('alert')).toHaveText(`${MEMBER.email} is already on the list.`);
	await row(page, ADMIN.email).getByRole('button', { name: `Remove admin for ${ADMIN.email}` }).click();
	await expect(page.getByRole('alert')).toHaveText('Pitman needs at least one admin.');
	await expect(row(page, ADMIN.email)).toContainText('Admin');
});

test('a 403 is shown as it comes', async ({ page }) => {
	await page.route('**/api/users', (route) => route.fulfill({ status: 403, json: { error: 'You are no longer an admin.' } }));
	await page.goto('/users');
	await expect(page.getByText('You are no longer an admin.')).toBeVisible();
});

test('the audit log reads as dates and sentences, never raw ISO', async ({ page }) => {
	await usersApi(page);
	await page.goto('/users');
	const log = page.getByRole('table', { name: 'Audit log' });
	await expect(log.getByRole('row')).toHaveCount(4);
	await expect(log.getByRole('row').nth(1)).toHaveText(/07 Nov 2026, 12:05\s*admin@example\.test signed in/);
	await expect(log.getByRole('row').nth(3)).toContainText('The operator made admin@example.test the first admin');
	await expect(log).not.toContainText('2026-11-07T');
	await expect(page.getByRole('table', { name: /Users/ })).not.toContainText('2026-11-07T');
	await expect(row(page, MEMBER.email)).toContainText('07 Nov 2026, 11:30 by admin@example.test');
});

test('a bounced address shows a readable badge until an admin clears it', async ({ page }) => {
	const api = await usersApi(page, {}, { kind: 'bounce', at: '2026-11-07T10:15:00Z' });
	await page.goto('/users');
	await expect(row(page, MEMBER.email)).toContainText('Mail bounced on 07 Nov 2026, 12:15');
	await expect(row(page, ADMIN.email)).not.toContainText('Mail');
	await expect(page.getByRole('table', { name: /Users/ })).not.toContainText('2026-11-07T');
	const clear = row(page, MEMBER.email).getByRole('button', { name: `Clear the mail problem for ${MEMBER.email}` });
	// WCAG 2.5.8: a 24 px target at least.
	const box = (await clear.boundingBox())!;
	expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
	await clear.click();
	await expect(page.getByRole('status')).toHaveText(`Cleared the mail problem for ${MEMBER.email}.`);
	await expect(row(page, MEMBER.email)).not.toContainText('Mail bounced');
	expect(api.calls.filter((c) => c.includes('clear-delivery-problem'))).toEqual([`POST /users/${MEMBER.id}/clear-delivery-problem {}`]);
});

test('a complaint reads as one', async ({ page }) => {
	await usersApi(page, {}, { kind: 'complaint', at: '2026-11-07T10:15:00Z' });
	await page.goto('/users');
	await expect(row(page, MEMBER.email)).toContainText('Mail complaint on 07 Nov 2026, 12:15');
});

test.describe('signed in without admin rights', () => {
	test.use({ signedInAs: MEMBER });

	test('there is no Users link, and /users refuses without asking the API', async ({ page }) => {
		let asked = 0;
		await page.route('**/api/users', (route) => {
			asked++;
			return route.fulfill({ status: 403, json: { error: 'Only an admin can see the user list.' } });
		});
		await page.goto('/');
		const account = page.getByRole('navigation', { name: 'Account' });
		await expect(account).toContainText(MEMBER.email);
		await expect(account.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
		await expect(account.getByRole('link', { name: 'Users' })).toHaveCount(0);
		await page.goto('/users');
		await expect(page.getByText('Only an admin can see and change who can sign in.')).toBeVisible();
		await expect(page.getByRole('table')).toHaveCount(0);
		expect(asked).toBe(0);
	});
});
