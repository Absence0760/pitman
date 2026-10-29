import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Recorded as the sidecar's `writtenBy` when a network is saved (src/lib/network/save.ts).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
	define: {
		__PITMAN_VERSION__: JSON.stringify(version)
	},
	// The run worker (src/lib/network/run.worker.ts) is an ES module worker.
	worker: { format: 'es' },
	plugins: [
		// SvelteKit 3 reads its configuration here; svelte.config.js is no longer read.
		sveltekit({
			preprocess: [vitePreprocess()],
			adapter: adapter(),
			paths: {
				// Kit rejects a base without a leading '/' at startup; the cast only tells the type checker.
				base: (process.env.BASE_PATH || '') as '' | `/${string}`
			},
			// Kit 3 polls _app/version.json hourly by default; nothing here reads `updated` (as IC-WBT).
			version: { pollInterval: 0 }
		})
	]
});
