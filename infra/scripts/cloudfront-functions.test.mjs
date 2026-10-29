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
	assert.equal(spa('/_app/immutable/entry/start.BYRKrWNM.js').uri, '/_app/immutable/entry/start.BYRKrWNM.js');
	assert.equal(spa('/_app/version.json').uri, '/_app/version.json');
	assert.equal(spa('/_app/immutable/missing.js').uri, '/_app/immutable/missing.js');
});

test('api_strip_prefix: /api/<route> reaches the app as /<route>', () => {
	const api = load('api_strip_prefix');
	assert.equal(api('/api/health').uri, '/health');
	assert.equal(api('/api/chirps/monthly').uri, '/chirps/monthly');
	assert.equal(api('/api/').uri, '/');
	const r = api('/api/quaternaries');
	assert.deepEqual(r.querystring, { a: { value: '1' } });
});
