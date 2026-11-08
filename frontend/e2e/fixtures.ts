import { test as base } from '@playwright/test';

// The shared fixture every spec imports instead of '@playwright/test' (issue #28 P5). Every route but /sign-in,
// /privacy and /methods asks GET /api/auth/me on load, so each page starts signed in as `signedInAs` (an admin by
// default; `test.use({ signedInAs: null })` for signed out, or a non-admin user). Any other /api call a spec doesn't
// mock gets the 404 `vite preview` gave before the dev proxy existed, so no spec reaches a real backend on :3001.
// A spec's own page.route() is registered later and so takes precedence over both.

export * from '@playwright/test';

export interface TestUser {
	readonly id: string;
	readonly email: string;
	readonly isAdmin: boolean;
}

export const ADMIN: TestUser = { id: 'u-admin', email: 'admin@example.test', isAdmin: true };
export const MEMBER: TestUser = { id: 'u-member', email: 'member@example.test', isAdmin: false };

export const test = base.extend<{ signedInAs: TestUser | null; waitForHydration: boolean }>({
	signedInAs: [ADMIN, { option: true }],
	// Off only for a spec that blocks the app's scripts on purpose (hydration.spec.ts).
	waitForHydration: [true, { option: true }],
	page: async ({ page, signedInAs, waitForHydration }, use) => {
		await page.route('**/api/**', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: 'Not Found' }));
		await page.route('**/api/auth/me', (route) =>
			signedInAs ? route.fulfill({ json: { user: signedInAs } }) : route.fulfill({ status: 401, json: { error: 'Not signed in.' } })
		);
		// The pages are prerendered, so a control can be acted on before the app hydrates and the action is
		// lost. Every navigation waits for the app's own signal, <html data-hydrated> (routes/+layout.svelte).
		const hydrated = async () => {
			if (waitForHydration) await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
		};
		const goto = page.goto.bind(page);
		const reload = page.reload.bind(page);
		page.goto = async (...args) => {
			const response = await goto(...args);
			await hydrated();
			return response;
		};
		page.reload = async (...args) => {
			const response = await reload(...args);
			await hydrated();
			return response;
		};
		await use(page);
	}
});
