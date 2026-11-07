// docs/STACK.md: nothing reachable from the Lambda entry may import dotenv (server.ts loads it for local
// dev only). Bundles lambda.ts as `pnpm build` does and checks what went in: no dotenv, no synthetic-data
// writer, no SMTP (nodemailer is the dev server's), and the SDK clients and auth-kit present. Then the
// entry's dispatch: an SQS batch goes to the mail-event handler, anything else to the Hono app.
import type { Context } from 'aws-lambda';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { eventsLogged, guardLogs } from './__tests__/logGuard.js';

describe('the Lambda bundle', () => {
	it('leaves out dotenv, SMTP and the synthetic copy’s writers, and takes in auth-kit and the SDK clients', async () => {
		const r = await build({
			entryPoints: [new URL('./lambda.ts', import.meta.url).pathname],
			bundle: true,
			platform: 'node',
			target: 'node20',
			format: 'esm',
			write: false,
			metafile: true,
			logLevel: 'silent'
		});
		const inputs = Object.keys(r.metafile.inputs);
		expect(inputs.some((p) => p.includes('/dotenv/'))).toBe(false);
		expect(inputs.some((p) => p.endsWith('server.ts'))).toBe(false);
		expect(inputs.some((p) => p.includes('/nodemailer/') || p.endsWith('mail.smtp.ts'))).toBe(false);
		expect(inputs.some((p) => p.includes('@aws-sdk/client-lambda'))).toBe(false);
		expect(inputs.some((p) => /chirps\/(synthetic|mirror\/writers)\.ts$/.test(p) || p.endsWith('mapgrid/synthetic.ts') || p.endsWith('delineation/syntheticDem.ts'))).toBe(false);
		for (const pkg of ['@aws-sdk/client-s3', '@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb', '@aws-sdk/client-sesv2', '@absence0760/auth-kit']) {
			expect(inputs.some((p) => p.includes(pkg)), pkg).toBe(true);
		}
	}, 30_000);
});

describe('the Lambda entry', () => {
	guardLogs();
	const context = {} as Context;

	it('sends an SQS batch to the mail-event handler', async () => {
		const { handler } = await import('./lambda.js');
		const body = JSON.stringify({ Type: 'Notification', Message: JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{}] } }) });
		const r = await handler({ Records: [{ eventSource: 'aws:sqs', messageId: 'm1', body }] } as never, context);
		expect(r).toEqual({ batchItemFailures: [] });
		expect(eventsLogged().filter((e) => e.event === 'mail.bounce')).toEqual([{ event: 'mail.bounce', bounceType: 'Transient', recipients: 1 }]);
	});

	it('sends a Function URL request to the app', async () => {
		const { handler } = await import('./lambda.js');
		const event = {
			version: '2.0',
			rawPath: '/health',
			rawQueryString: '',
			headers: { host: 'example.lambda-url.af-south-1.on.aws' },
			requestContext: { http: { method: 'GET', path: '/health', sourceIp: '127.0.0.1' }, domainName: 'example.lambda-url.af-south-1.on.aws' },
			isBase64Encoded: false
		};
		const r = (await handler(event as never, context)) as { statusCode: number; body: string };
		expect(r.statusCode).toBe(200);
		expect(JSON.parse(r.body)).toEqual({ ok: true });
	});
});
