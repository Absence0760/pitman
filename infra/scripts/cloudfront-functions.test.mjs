// node --test infra/scripts/*.test.mjs
// Runs the CloudFront Functions in infra/functions/ (cloudfront-js-2.0 is
// plain ES5.1+ with a top-level `handler`) in a bare VM context.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const load = (name) => {
	const ctx = vm.createContext({});
	vm.runInContext(readFileSync(new URL(`../functions/${name}.js`, import.meta.url), 'utf8'), ctx);
	return (uri) => ctx.handler({ request: { uri, method: 'GET', querystring: { a: { value: '1' } }, headers: {} } });
};

test('spa_rewrite: client routes get index.html, files pass through', () => {
	const spa = load('spa_rewrite');
	assert.equal(spa('/').uri, '/index.html');
	assert.equal(spa('/extend').uri, '/index.html');
	assert.equal(spa('/a/b/').uri, '/index.html');
	assert.equal(spa('/index.html').uri, '/index.html');
	assert.equal(spa('/methods').uri, '/methods.html');
	assert.equal(spa('/methods/').uri, '/methods.html');
	assert.equal(spa('/methods.html').uri, '/methods.html');
	for (const page of ['privacy', 'sign-in', 'users']) {
		assert.equal(spa(`/${page}`).uri, `/${page}.html`);
		assert.equal(spa(`/${page}/`).uri, `/${page}.html`);
	}
	assert.equal(spa('/_app/immutable/entry/start.BYRKrWNM.js').uri, '/_app/immutable/entry/start.BYRKrWNM.js');
	assert.equal(spa('/_app/version.json').uri, '/_app/version.json');
	assert.equal(spa('/_app/immutable/missing.js').uri, '/_app/immutable/missing.js');
});

// security_headers.js.tftpl, rendered as infra/security_headers.tf renders it:
// the behaviour's name and csp.json's CSP for it (directives joined by "; ",
// sources by " ") as JSON string literals. terraform test pins the rendered
// code's CSP line to the same string (tests/stack.tftest.hcl).
const cspJson = JSON.parse(readFileSync(new URL('../csp.json', import.meta.url), 'utf8'));
const cspFor = (behaviour) => cspJson[behaviour].map((d) => d.join(' ')).join('; ');
const template = readFileSync(new URL('../functions/security_headers.js.tftpl', import.meta.url), 'utf8');

const renderHeaders = (behaviour) => {
	const vars = { behaviour: JSON.stringify(behaviour), csp: JSON.stringify(cspFor(behaviour)) };
	const code = template.replace(/\$\{(\w+)\}/g, (_, name) => {
		assert.ok(name in vars, `unknown template variable ${name}`);
		return vars[name];
	});
	assert.doesNotMatch(code, /\$\{|%\{/, 'every template directive rendered');
	return code;
};

const loadHeaders = (behaviour) => {
	const code = renderHeaders(behaviour);
	const ctx = vm.createContext({});
	vm.runInContext(code, ctx);
	return (status, headers = {}) => ctx.handler({ request: { uri: '/x', method: 'GET', querystring: {}, headers: {} }, response: { statusCode: status, headers } });
};

const COMMON = {
	'strict-transport-security': 'max-age=63072000; includeSubDomains',
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'x-xss-protection': '0',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
	'cross-origin-opener-policy': 'same-origin'
};

// The exact set the response headers policies set before R4-I14, per behaviour.
const EXPECTED = {
	site: { ...COMMON, 'content-security-policy': cspFor('site'), 'referrer-policy': 'strict-origin-when-cross-origin' },
	api: { ...COMMON, 'content-security-policy': cspFor('api'), 'referrer-policy': 'no-referrer' }
};

const values = (headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.value]));

for (const behaviour of ['site', 'api']) {
	test(`security_headers (${behaviour}): exactly the security header set, nothing else added`, () => {
		const respond = loadHeaders(behaviour);
		const out = respond(200, {});
		assert.deepEqual(values(out.headers), EXPECTED[behaviour]);
		assert.equal(out.statusCode, 200);
	});

	test(`security_headers (${behaviour}): overrides the origin's values and keeps its other headers`, () => {
		const respond = loadHeaders(behaviour);
		const origin = {
			'content-type': { value: 'text/html' },
			'cache-control': { value: 'max-age=0' },
			'content-security-policy': { value: '*' },
			'x-frame-options': { value: 'SAMEORIGIN' },
			'referrer-policy': { value: 'unsafe-url' },
			'strict-transport-security': { value: 'max-age=0' }
		};
		const out = respond(304, origin);
		assert.deepEqual(values(out.headers), { ...EXPECTED[behaviour], 'content-type': 'text/html', 'cache-control': 'max-age=0' });
	});

	test(`security_headers (${behaviour}): the rendered code fits CloudFront Functions' 10 KB`, () => {
		assert.ok(Buffer.byteLength(renderHeaders(behaviour)) < 10 * 1024);
	});
}

test('security_headers: the site and API CSPs are csp.json\'s, and differ where they must', () => {
	assert.match(cspFor('site'), /^default-src 'self'; /);
	assert.match(cspFor('site'), /frame-ancestors 'none'/);
	assert.equal(cspFor('api'), "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
});

test('api_strip_prefix: /api/<route> reaches the app as /<route>', () => {
	const api = load('api_strip_prefix');
	assert.equal(api('/api/health').uri, '/health');
	assert.equal(api('/api/chirps/monthly').uri, '/chirps/monthly');
	assert.equal(api('/api/').uri, '/');
	const r = api('/api/quaternaries');
	assert.deepEqual(r.querystring, { a: { value: '1' } });
});
