import { readFileSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

// Recorded as the sidecar's `writtenBy` when a network is saved (src/lib/network/save.ts).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const MAPLIBRE_WORKER_ID = 'virtual:maplibre-worker-url';
const MAPLIBRE_WORKER_FILE = realpathSync(fileURLToPath(new URL('./node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url)));

/**
 * MapLibre's worker as a chunk of the page build, ported from IC-WBT
 * (Absence0760/project-water-management, MIT) frontend/vite.config.ts
 * `workerChunks` at f888e4461, stripped to the one worker. `lib/map/maplibre.ts`
 * hands this URL to `setWorkerUrl`; it is served from the app's own origin, so
 * the CSP's `worker-src 'self'` holds without blob: (docs/security.md). In dev
 * Vite serves the vendor file through /@fs/; the server build never starts one.
 */
function maplibreWorkerChunk(): Plugin {
	const resolved = '\0' + MAPLIBRE_WORKER_ID;
	let serve = false;
	return {
		name: 'pitman:maplibre-worker-chunk',
		configResolved(config) {
			serve = config.command === 'serve';
		},
		resolveId(id) {
			return id === MAPLIBRE_WORKER_ID ? resolved : undefined;
		},
		load(id, options) {
			if (id !== resolved) return undefined;
			if (options?.ssr) return 'export default "";';
			if (serve) return `export default ${JSON.stringify('/@fs' + MAPLIBRE_WORKER_FILE.split(sep).join('/'))};`;
			const ref = this.emitFile({ type: 'chunk', id: MAPLIBRE_WORKER_FILE });
			return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
		},
		// SvelteKit names chunks by a function; give this one a name under workers/, beside the run worker.
		outputOptions(output) {
			const chunkFileNames = output.chunkFileNames;
			if (typeof chunkFileNames !== 'function') return undefined;
			return {
				...output,
				chunkFileNames: (chunk) => {
					const pattern = chunkFileNames(chunk);
					return chunk.facadeModuleId === MAPLIBRE_WORKER_FILE && pattern.includes('/chunks/') ? pattern.replace(/\/chunks\/.*$/, '/workers/maplibre.worker-[hash].js') : pattern;
				}
			};
		}
	};
}

/**
 * Same origin in dev, as in production (A-AUTH-9): the browser calls `/api/*`
 * on the page's own origin and Vite passes it to the Hono dev server with
 * `/api` stripped, as CloudFront does (R4-I4). The session cookie is then a
 * first-party cookie and CORS needs no credentials. `PITMAN_API_TARGET`
 * points it elsewhere (another port). The end-to-end tests mock every `/api`
 * call (e2e/fixtures.ts), so they never reach it.
 */
// 127.0.0.1, not localhost: the backend listens on loopback IPv4 only (backend/src/http/listen.ts), and
// localhost resolves to ::1 first on this host.
const API_TARGET = process.env.PITMAN_API_TARGET || 'http://127.0.0.1:3001';
const apiProxy = { '/api': { target: API_TARGET, rewrite: (path: string) => path.replace(/^\/api(?=\/|$)/, '') || '/' } };

export default defineConfig({
	server: { proxy: apiProxy },
	preview: { proxy: apiProxy },
	define: {
		__PITMAN_VERSION__: JSON.stringify(version)
	},
	// The run worker (src/lib/network/run.worker.ts) is an ES module worker.
	worker: { format: 'es' },
	plugins: [
		maplibreWorkerChunk(),
		// SvelteKit 3 reads its configuration here; svelte.config.js is no longer read.
		sveltekit({
			preprocess: [vitePreprocess()],
			adapter: adapter(),
			paths: {
				// Kit rejects a base without a leading '/' at startup; the cast only tells the type checker.
				base: (process.env.BASE_PATH || '') as '' | `/${string}`
			},
			// Kit 3 polls _app/version.json hourly by default; nothing here reads `updated` (as IC-WBT).
			version: { pollInterval: 0 },
			// The CloudFront header allows script-src 'unsafe-inline' because the bootstrap script's hash
			// changes every build; this meta CSP (hash mode) is enforced on top of it, so only the hashed
			// bootstrap runs. infra/scripts/check-csp.mjs refuses a build without it (decision R4-I1).
			csp: { mode: 'hash', directives: { 'script-src': ['self'] } }
		})
	]
});
