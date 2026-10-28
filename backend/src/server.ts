// Load local-dev env. Committed .env.development holds non-sensitive defaults;
// the gitignored .env.development.local (listed first → wins) holds personal
// overrides and any real secrets. Missing files are skipped silently, so a
// fresh clone runs with zero env setup. This is only reached via server.ts
// (the local Node entry point) — the Lambda entry in lambda.ts never imports
// server.ts, so esbuild tree-shakes dotenv out of the deployment bundle.
import { config } from 'dotenv';
config({ path: ['.env.development.local', '.env.development'] });

import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, (info) => {
	console.log(`Backend listening on http://localhost:${info.port}`);
});
