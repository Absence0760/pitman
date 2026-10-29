/**
 * Environment variables the app reads (SvelteKit 3's `src/env.ts`; they
 * are imported from `$app/env/public`). Values come from the committed
 * `.env.development` in dev and from the build environment in CI
 * (`deploy-frontend.yml`).
 */

import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_API_URL: {
		public: true,
		// Inlined at build time: the site is static (adapter-static), nothing reads the environment when it runs.
		static: true,
		// Unset (a local `vite build`, the end-to-end tests) means production's same-origin `/api` (decision R4-I4).
		schema: (value) => value ?? '/api',
		description: 'Base URL of the backend API: http://localhost:3001 in dev; /api in production (same origin; CloudFront strips /api).'
	}
});
