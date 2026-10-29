import { defineConfig } from 'vitest/config';

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
		environment: 'node',
		include: ['src/**/*.test.ts'],
		exclude: ['node_modules/**', 'dist/**']
	}
});
