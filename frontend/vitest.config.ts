import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so the SvelteKit plugin (which needs a full
// dev-server lifecycle) isn't pulled into the Vitest runtime. Tests that
// touch SvelteKit virtual modules like `$env/static/public` mock them with
// `vi.mock()` instead.
export default defineConfig({
	test: {
		// Coverage (`pnpm test:coverage`): a report, never a gate. No thresholds:
		// a number to hit invites tests written for the number. Read it for what
		// no test reaches (docs/STACK.md § Commands).
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
			reporter: ['text-summary', 'json-summary', 'html']
		},
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
