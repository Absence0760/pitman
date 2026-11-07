import { expect, test } from './fixtures.js';

// `pnpm dev`, not the build: every other spec runs against vite preview, so a page that only
// fails under vite dev (a CSS import reaching Node during server rendering answered 500 here) goes unseen.
for (const path of ['/', '/methods', '/sign-in', '/privacy', '/users']) {
	test(`the dev server renders ${path}`, async ({ request }) => {
		expect((await request.get(`http://127.0.0.1:8889${path}`)).status()).toBe(200);
	});
}
