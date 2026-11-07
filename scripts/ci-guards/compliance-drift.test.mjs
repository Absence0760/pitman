// Tests for the compliance-drift advisory (compliance-drift.mjs, `pnpm check:compliance`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	authKitPinMoved,
	collectFindings,
	docNamesHost,
	docNamesIdentifier,
	hostsInDiff,
	isPiiIdentifier,
	piiConcepts,
	piiIdentifiersInDiff,
	sdkDependenciesInDiff,
	words,
} from './compliance-drift.mjs';

const SECURITY = 'Sign-in stores an email address per user. The WAF limits are per IP.';
const DATA = 'CHIRPS from chc.ucsb.edu. Basemap © OpenStreetMap contributors. Manuals from the WRC.';

test('words splits camelCase, acronyms and snake_case', () => {
	assert.equal(words('clientIPAddress'), 'client ip address');
	assert.equal(words('DEV_ADMIN_EMAIL'), 'dev admin email');
	assert.equal(words('userAgent'), 'user agent');
});

test('PII identifiers match per word, not per substring', () => {
	for (const id of ['phoneNumber', 'client_ip', 'emailVerifiedAt', 'displayName', 'user_agent', 'homeAddress', 'dateOfBirth', 'idNumber']) {
		assert.ok(isPiiIdentifier(id), id);
	}
	for (const id of ['capacity', 'pipeline', 'zip', 'shipDate', 'name', 'damName', 'address', 'skip', 'description', 'tip']) {
		assert.ok(!isPiiIdentifier(id), id);
	}
	assert.deepEqual(piiConcepts('clientIpAddress'), ['ip', 'ip address']);
});

test('a doc covers an identifier when it names every personal-data concept in it', () => {
	assert.ok(docNamesIdentifier('badEmail', SECURITY));
	assert.ok(docNamesIdentifier('DEV_ADMIN_EMAIL', SECURITY));
	assert.ok(docNamesIdentifier('clientIp', SECURITY));
	assert.ok(!docNamesIdentifier('phoneNumber', SECURITY));
	assert.ok(!docNamesIdentifier('displayName', SECURITY));
	assert.ok(docNamesIdentifier('displayName', 'We keep a display name.'));
	assert.ok(!docNamesIdentifier('emailPhone', SECURITY), 'both concepts must be named');
});

test('hostsInDiff: added, non-comment lines only', () => {
	const diff = [
		"+const a = 'https://api.segment.io/v1/track';",
		'+// see https://docs.somewhere.io for details',
		'+<!-- https://comment.io -->',
		" const e = 'https://unchanged.io';",
		"-const f = 'https://removed.io';",
	].join('\n');
	assert.deepEqual(hostsInDiff(diff), ['api.segment.io']);
});

test('a doc names a host by itself, a parent domain, or its registrable label as a word', () => {
	assert.ok(docNamesHost('data.chc.ucsb.edu', DATA));
	assert.ok(docNamesHost('www.openstreetmap.org', DATA));
	assert.ok(docNamesHost('www.wrc.org.za', DATA));
	assert.ok(!docNamesHost('inforegulator.org.za', DATA));
	assert.ok(!docNamesHost('api.segment.io', DATA));
	assert.ok(!docNamesHost('org.za', 'org.za'), 'a bare second-level suffix names nothing');
});

test('SDK dependencies are found; ordinary deps are not', () => {
	const diff = '+    "@sentry/sveltekit": "^9.0.0",\n+    "uplot": "1.6.32",\n+    "posthog-js": "1.0.0",\n+    "@opentelemetry/api": "1.9.0"';
	assert.deepEqual(sdkDependenciesInDiff(diff), ['@opentelemetry/api', '@sentry/sveltekit', 'posthog-js']);
});

test('PII identifiers in a code diff skip comments and removed lines', () => {
	const diff = ['+const row = { phoneNumber: body.phone, email };', '+// displayName is not stored', '-const old = u.userAgent;'].join('\n');
	assert.deepEqual(piiIdentifiersInDiff(diff), ['email', 'phone', 'phoneNumber']);
});

test('the auth-kit pin moving is seen; other backend/package.json edits are not', () => {
	const bump = '-\t\t"@absence0760/auth-kit": "github:Absence0760/auth-kit#v0.1.2",\n+\t\t"@absence0760/auth-kit": "github:Absence0760/auth-kit#v0.2.0",';
	assert.ok(authKitPinMoved(bump));
	assert.ok(authKitPinMoved('+\t\t"@absence0760/auth-kit": "github:Absence0760/auth-kit#v0.1.0",'), 'first install');
	assert.ok(!authKitPinMoved('-\t\t"hono": "4.13.15",\n+\t\t"hono": "4.13.16",'));
});

const DIFFS = {
	'frontend/src/lib/telemetry.ts': "+fetch('https://api.segment.io/v1/track')",
	'frontend/package.json': '+    "@sentry/sveltekit": "^9.0.0",',
	'backend/src/auth/routes.ts': '+const me = (u) => ({ id: u.id, email: u.email, phoneNumber: u.phoneNumber });',
	'backend/package.json': '-    "@absence0760/auth-kit": "github:x#v0.2.0",\n+    "@absence0760/auth-kit": "github:x#v0.3.0",',
};
const docAtHead = (/** @type {string} */ f) => (f === 'docs/security.md' ? SECURITY : f === 'docs/data.md' ? DATA : '');
const diffFor = (/** @type {string} */ f) => DIFFS[/** @type {keyof DIFFS} */ (f)] ?? '';

test('collectFindings fires on each rule without the companion doc', () => {
	const f = collectFindings({ files: Object.keys(DIFFS), diffFor, docAtHead });
	assert.deepEqual(
		f.map((x) => x.rule),
		['outbound-host', 'sdk-dependency', 'pii-field', 'auth-kit-bump']
	);
	assert.match(f[2].detail, /phoneNumber/);
	assert.doesNotMatch(f[2].detail, /\bemail\b,/, 'email is already documented');
});

test('changing docs/security.md quiets every rule; docs/data.md quiets the host rule only', () => {
	assert.deepEqual(collectFindings({ files: [...Object.keys(DIFFS), 'docs/security.md'], diffFor, docAtHead }), []);
	const withData = collectFindings({ files: [...Object.keys(DIFFS), 'docs/data.md'], diffFor, docAtHead });
	assert.deepEqual(
		withData.map((x) => x.rule),
		['sdk-dependency', 'pii-field', 'auth-kit-bump']
	);
});

test('known and already-documented hosts stay quiet', () => {
	const diffs = {
		'backend/src/chirps/x.ts': [
			"+const a = 'http://localhost:3001';",
			"+const b = 'https://s3.af-south-1.amazonaws.com';",
			"+const c = 'https://pitman.jaredhoward.com/x';",
			"+const d = 'https://gis.example.test';",
			"+const e = 'https://data.chc.ucsb.edu/x';",
			"+const ns = 'http://www.w3.org/2000/svg';",
		].join('\n'),
	};
	assert.deepEqual(collectFindings({ files: Object.keys(diffs), diffFor: (f) => diffs[f] ?? '', docAtHead }), []);
});

test('tests, e2e specs and files outside the watched areas are ignored', () => {
	const diff = "+const x = { phoneNumber: 'https://api.segment.io' };";
	const files = ['backend/src/auth/routes.test.ts', 'frontend/e2e/x.spec.ts', 'backend/src/__tests__/h.ts', 'docs/api.md', 'infra/lambda.tf'];
	assert.deepEqual(collectFindings({ files, diffFor: () => diff, docAtHead }), []);
});

test('the operator scripts and the user table count as the sign-in area', () => {
	const f = collectFindings({
		files: ['backend/scripts/erase-address.ts', 'infra/users.tf'],
		diffFor: () => '+  phone_number = var.x',
		docAtHead,
	});
	assert.deepEqual(
		f.map((x) => `${x.file} ${x.rule}`),
		['backend/scripts/erase-address.ts pii-field', 'infra/users.tf pii-field']
	);
});
