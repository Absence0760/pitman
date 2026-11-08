// The API's own security headers (R4-I14): set on every response, and the same values CloudFront's
// viewer-response function sets on /api/* (infra/functions/security_headers.js.tftpl with
// infra/csp.json's `api` CSP), so the edge and the app can't drift. Every route through createApp()
// is in app.test.ts.
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { API_SECURITY_HEADERS, securityHeaders } from './securityHeaders.js';

const infra = (path: string) => readFileSync(new URL(`../../../infra/${path}`, import.meta.url), 'utf8');

describe('securityHeaders', () => {
	const app = new Hono();
	app.use('*', securityHeaders());
	app.get('/ok', (c) => c.json({ ok: true }));
	app.get('/own', (c) => c.json({ ok: true }, 200, { 'x-frame-options': 'SAMEORIGIN', 'cache-control': 'no-store' }));
	app.get('/thrown', () => {
		throw new HTTPException(429, { message: 'slow down' });
	});
	app.get('/crash', () => {
		throw new Error('boom');
	});

	it.each(['/ok', '/own', '/thrown', '/crash', '/missing'])('sets every header on %s, overriding the handler', async (path) => {
		const res = await app.request(path);
		for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
	});

	it('leaves the handler’s other headers alone', async () => {
		expect((await app.request('/own')).headers.get('cache-control')).toBe('no-store');
	});
});

describe('API_SECURITY_HEADERS against the CloudFront function', () => {
	it('carries infra/csp.json’s api CSP, joined as Terraform joins it', () => {
		const csp = JSON.parse(infra('csp.json')) as { api: string[][] };
		expect(API_SECURITY_HEADERS['content-security-policy']).toBe(csp.api.map((d) => d.join(' ')).join('; '));
	});

	it('has the template’s header names and values, with the api Referrer-Policy', () => {
		const template = infra('functions/security_headers.js.tftpl');
		const headers = /var HEADERS = \{([^}]*)\}/.exec(template)?.[1] ?? '';
		const names = [...headers.matchAll(/'([a-z-]+)':/g)].map((m) => m[1]);
		expect(names.sort()).toEqual(Object.keys(API_SECURITY_HEADERS).sort());
		for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
			if (name === 'content-security-policy') expect(headers).toContain(`'${name}': CSP,`);
			else if (name === 'referrer-policy') expect(template).toContain(`api: '${value}'`);
			else expect(headers).toContain(`'${name}': '${value}'`);
		}
	});
});
