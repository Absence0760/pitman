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
import { smtpMailer } from './auth/mail.smtp.js';
import { authRuntimeFromEnv } from './auth/runtime.js';

// The dev server alone may send through SMTP (Mailpit), so nodemailer stays out of the Lambda bundle.
const auth = authRuntimeFromEnv(process.env, { smtp: smtpMailer });

// Dev only: with the in-memory user store (USER_STORE=memory, the default) the list starts empty on
// every restart, so DEV_ADMIN_EMAIL (admin@example.test in .env.development) is made the first admin.
// DynamoDB Local is seeded once instead (`pnpm dev:auth:seed`). Never reached from lambda.ts.
const devAdmin = process.env.DEV_ADMIN_EMAIL;
if (auth.ready && devAdmin && (process.env.USER_STORE || 'memory') === 'memory') {
	const r = await auth.kit.bootstrapAdmin(devAdmin);
	console.log(r.ok ? 'Dev admin seeded into the in-memory user list (DEV_ADMIN_EMAIL)' : `Dev admin not seeded: ${r.error}`);
}

const app = createApp({ auth });
const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, (info) => {
	console.log(`Backend listening on http://localhost:${info.port}`);
});
