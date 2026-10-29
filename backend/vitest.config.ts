import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Coverage (`pnpm test:coverage`): a report, never a gate. No thresholds:
		// a number to hit invites tests written for the number. Read it for what
		// no test reaches (docs/STACK.md § Commands).
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/__tests__/**'],
			reporter: ['text-summary', 'json-summary', 'html']
		},
		environment: 'node',
		// Env vars set once for every test file. Individual tests can override
		// via vi.stubEnv() if they need to exercise a missing-env code path.
		setupFiles: ['./src/__tests__/setup.ts'],
		// Don't pick up the dist/ folder from previous builds.
		exclude: ['node_modules/**', 'dist/**'],
		include: ['src/**/*.test.ts']
	}
});
