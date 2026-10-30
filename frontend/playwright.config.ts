import { defineConfig, devices } from '@playwright/test';

// End-to-end tests (Playwright; unit tests stay on vitest). Runs against the
// built static site served by `vite preview`, the same files S3 serves.
export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.spec.ts',
	forbidOnly: !!process.env.CI,
	reporter: process.env.CI ? 'github' : 'list',
	use: { baseURL: 'http://127.0.0.1:8888', trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: [
		{
			// 127.0.0.1, not localhost: vite binds localhost to ::1 only on this host, which the readiness check misses.
			command: 'pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 8888 --strictPort',
			url: 'http://127.0.0.1:8888',
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
			// Without this the run never exits: Playwright waits forever for preview to close while a
			// browser keep-alive connection holds it open. SIGTERM, then SIGKILL after 3 s.
			gracefulShutdown: { signal: 'SIGTERM', timeout: 3_000 }
		},
		// `pnpm dev` too: server rendering under vite dev fails in ways a build doesn't (e2e/dev-smoke.spec.ts).
		{
			command: 'pnpm exec vite dev --host 127.0.0.1 --port 8889 --strictPort',
			url: 'http://127.0.0.1:8889',
			reuseExistingServer: !process.env.CI,
			timeout: 60_000,
			gracefulShutdown: { signal: 'SIGTERM', timeout: 3_000 }
		}
	]
});
