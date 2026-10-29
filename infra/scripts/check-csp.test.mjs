// node --test infra/scripts/*.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkHeaderPolicy, checkHtml, headerPolicy } from './check-csp.mjs';

const sha = (t) => `'sha256-${createHash('sha256').update(t, 'utf8').digest('base64')}'`;
const cspJson = JSON.parse(readFileSync(new URL('../csp.json', import.meta.url), 'utf8'));
const policy = headerPolicy(cspJson);

const boot = '\n\t\t\t\t{ __sveltekit_x = {}; import("./_app/immutable/entry/start.js"); }\n\t\t\t';
const page = ({ meta = `<meta http-equiv="content-security-policy" content="script-src 'self' ${sha(boot)}">`, body = '<div style="display: contents">', script = boot } = {}) =>
	`<!doctype html><html><head>${meta}</head><body>${body}<script>${script}</script></div></body></html>`;

test('the committed csp.json is strict', () => {
	assert.deepEqual(checkHeaderPolicy(policy), []);
});

test("a SvelteKit page with its hashed bootstrap and app.html's style passes", () => {
	assert.deepEqual(checkHtml(page(), policy).errors, []);
});

test('no meta CSP: refused, naming the sveltekit option', () => {
	const { errors } = checkHtml(page({ meta: '' }), policy);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /csp: \{ mode: 'hash'/);
});

test('a bootstrap whose hash is missing is refused', () => {
	const { errors } = checkHtml(page({ script: boot + 'alert(1)' }), policy);
	assert.match(errors.join('\n'), /is not in the meta CSP script-src/);
});

test("a meta CSP allowing 'unsafe-inline' is refused", () => {
	const { errors } = checkHtml(page({ meta: `<meta http-equiv="content-security-policy" content="script-src 'self' 'unsafe-inline' ${sha(boot)}">` }), policy);
	assert.match(errors.join('\n'), /allows 'unsafe-inline'/);
});

test('a script before the meta tag is refused', () => {
	const html = `<html><head><script src="x.js"></script><meta http-equiv="content-security-policy" content="script-src 'self'"></head></html>`;
	assert.match(checkHtml(html, policy).errors.join('\n'), /before the meta CSP/);
});

test('JSON data blocks and src scripts need no hash', () => {
	const html = page({ body: '<div style="display: contents"><script type="application/json">{"a":1}</script><script type="module" src="./a.js"></script>' });
	assert.deepEqual(checkHtml(html, policy).errors, []);
});

test('an inline event handler is refused', () => {
	assert.match(checkHtml(page({ body: '<div style="display: contents"><button onclick="x()">' }), policy).errors.join('\n'), /onclick=/);
});

test('a new style attribute is refused with the hash to add', () => {
	const { errors } = checkHtml(page({ body: '<div style="display: contents"><p style="color: red">' }), policy);
	assert.equal(errors.length, 1);
	assert.ok(errors[0].includes(sha('color: red')));
});

test('a style attribute is hashed after entity decoding', () => {
	const p = headerPolicy({ site: [['style-src', "'self'", "'unsafe-hashes'", sha('font-family: "A"'), sha('display: contents')]] });
	assert.deepEqual(checkHtml(page({ body: '<div style="display: contents"><p style="font-family: &quot;A&quot;">' }), p).errors, []);
});

test('data-style and other look-alike attributes are not style attributes', () => {
	assert.deepEqual(checkHtml(page({ body: '<div style="display: contents"><p data-style="x">' }), policy).errors, []);
});

test('an inline <style> element needs its hash', () => {
	const { errors } = checkHtml(page({ body: '<div style="display: contents"><style>p{color:red}</style>' }), policy);
	assert.ok(errors.join('\n').includes(sha('p{color:red}')));
});

test('a hashed style attribute without unsafe-hashes is still refused', () => {
	const p = headerPolicy({ site: [['style-src', "'self'", sha('display: contents')]] });
	assert.match(checkHtml(page(), p).errors.join('\n'), /not allowed/);
});

test('header policy checks catch loosening', () => {
	const loose = headerPolicy({
		site: [
			['default-src', "'self'"],
			['script-src', "'self'", "'unsafe-eval'"],
			['style-src', "'self'", "'unsafe-inline'"],
			['connect-src', "'self'", 'https://example.com']
		]
	});
	const errors = checkHeaderPolicy(loose).join('\n');
	assert.match(errors, /script-src allows 'unsafe-eval'/);
	assert.match(errors, /style-src allows 'unsafe-inline'/);
	assert.match(errors, /connect-src must be exactly 'self'/);
});
