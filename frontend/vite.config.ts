import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
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
