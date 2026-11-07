// Tests for the env-isolation guard (env-isolation.mjs, `pnpm check:env`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEnvFile, checkTrackedFiles, hostsIn, isLocalHost, mailDomainsIn, parseEnv } from './env-isolation.mjs';

const rules = (/** @type {string} */ file, /** @type {string} */ text) => checkEnvFile(file, text).map((f) => f.rule).join('\n');

test('tracked files: dev defaults, examples and key lists only', () => {
	const ok = [
		'backend/.env.development',
		'frontend/.env.development',
		'backend/.env.example',
		'infra/terraform.tfvars.example',
		'infra/prod.sops.yaml.example',
		'README.md',
		'frontend/src/lib/env.ts',
	];
	assert.deepEqual(checkTrackedFiles(ok), []);
	const bad = checkTrackedFiles(['.env', 'backend/.env.local', 'backend/.env.production', 'backend/.env.development.local', 'frontend/.env']);
	assert.deepEqual(
		bad.map((f) => f.file),
		['.env', 'backend/.env.local', 'backend/.env.production', 'backend/.env.development.local', 'frontend/.env']
	);
});

test('sops payloads, sops config and tfvars are refused', () => {
	const bad = checkTrackedFiles(['.sops.yaml', 'infra/prod.sops.yaml', 'x/secrets.sops.json', 'y/a.sops', 'infra/terraform.tfvars', 'infra/x.tfvars.json']);
	assert.equal(bad.length, 6);
	assert.equal(bad.filter((f) => /sops/.test(f.rule)).length, 4);
	assert.equal(bad.filter((f) => /Terraform/.test(f.rule)).length, 2);
});

test('parseEnv skips comments and blanks, strips quotes, keeps line numbers', () => {
	assert.deepEqual(parseEnv('# c\n\nA=1\nB="two"\n  # USERS_TABLE=x\nexport C=3\nnot a pair\n'), [
		{ line: 3, key: 'A', value: '1' },
		{ line: 4, key: 'B', value: 'two' },
		{ line: 6, key: 'C', value: '3' },
	]);
});

test('hostsIn and mailDomainsIn find what a value points at', () => {
	assert.deepEqual(hostsIn('http://localhost:7777,http://127.0.0.1:8888'), ['localhost', '127.0.0.1']);
	assert.deepEqual(hostsIn('smtp://u:p@mail.example.org:25'), ['mail.example.org']);
	assert.deepEqual(hostsIn('http://[::1]:3000'), ['::1']);
	assert.deepEqual(hostsIn('/api'), []);
	assert.ok(isLocalHost('app.localhost'));
	assert.ok(!isLocalHost('localhost.evil.com'));
	assert.deepEqual(mailDomainsIn('Pitman <no-reply@localhost>'), ['localhost']);
	assert.deepEqual(mailDomainsIn('smtp://user:pw@host.test'), [], "a URL's userinfo is a host, not an address");
});

// pitman's committed backend default, shape for shape (keys, not its values' exact prose).
const backendOk = [
	'ALLOWED_ORIGINS=http://localhost:7777,http://127.0.0.1:7777,http://localhost:8888',
	'SITE_URL=http://localhost:7777',
	'PORT=3001',
	'CLOUDFRONT_SHARED_SECRET=',
	'CHIRPS_SOURCE=local',
	'CHIRPS_LOCAL_DIR=.local/mirror',
	'MAP_GRID_SOURCE=local',
	'MAP_GRID_LOCAL_FILE=.local/map-grid/synthetic.json',
	'DEM_SOURCE=local',
	'QUATERNARIES_SOURCE=local',
	'QUATERNARIES_LOCAL_FILE=fixtures/geo/quaternaries.synthetic.geojson',
	'CFM_SOURCE=local',
	'#   USERS_TABLE=pitman-users-local',
	'#   DYNAMODB_ENDPOINT=http://127.0.0.1:8000',
	'USER_STORE=memory',
	'MAIL_TRANSPORT=console',
	'MAIL_QUEUE=inline',
	'MAIL_FROM="Pitman <no-reply@localhost>"',
	'SMTP_HOST=127.0.0.1',
	'SMTP_PORT=1025',
	'DEV_ADMIN_EMAIL=admin@example.test',
	'AUTH_CODE_KEY=dev-only-code-key-not-a-secret-0123456789',
	'AUTH_SESSION_KEY=dev-only-session-key-not-a-secret-0123456789',
	'AUTH_DEV_COOKIE=true',
	'# SITE_URL=https://pitman.jaredhoward.com (comments may name real hosts)',
].join('\n');

test('a local-only backend dev default passes (positive control)', () => {
	assert.deepEqual(checkEnvFile('backend/.env.development', backendOk), []);
	assert.deepEqual(checkEnvFile('backend/.env.development', 'USER_STORE=dynamodb\nUSERS_TABLE=pitman-users-local\nDYNAMODB_ENDPOINT=http://127.0.0.1:8000\nMAIL_TRANSPORT=smtp\n'), []);
});

test('a non-local host fails, and the value is not echoed', () => {
	const f = checkEnvFile('backend/.env.development', 'DYNAMODB_ENDPOINT=https://hunter2@dynamodb.af-south-1.amazonaws.com\n');
	assert.equal(f.length, 1);
	assert.equal(f[0].line, 1);
	assert.doesNotMatch(f[0].rule, /hunter2|amazonaws/);
	assert.match(rules('backend/.env.development', 'SMTP_HOST=email-smtp.af-south-1.amazonaws.com'), /SMTP_HOST is not a local host/);
	assert.match(rules('backend/.env.development', 'SITE_URL=https://pitman.jaredhoward.com'), /SITE_URL names a non-local host/);
});

test('an address on a real domain fails (no real mailbox in git); reserved domains pass', () => {
	assert.match(rules('backend/.env.development', 'DEV_ADMIN_EMAIL=someone@gmail.com'), /real domain/);
	assert.match(rules('backend/.env.development', 'MAIL_FROM="Pitman <no-reply@pitman.jaredhoward.com>"'), /real domain/);
	for (const v of ['a@example.test', 'a@localhost', 'a@x.example', 'a@example.com', 'a@nowhere.invalid']) {
		assert.deepEqual(checkEnvFile('backend/.env.development', `DEV_ADMIN_EMAIL=${v}`), [], v);
	}
});

test('a secret-named key is empty or dev-only-; AWS credentials are never set', () => {
	assert.match(rules('backend/.env.development', 'AUTH_SESSION_KEY=4f9c0e7a1b'), /AUTH_SESSION_KEY is neither empty nor a dev-only-/);
	assert.match(rules('backend/.env.development', 'AUTH_CODE_KEY=real'), /AUTH_CODE_KEY/);
	assert.match(rules('backend/.env.development', 'CLOUDFRONT_SHARED_SECRET=abc'), /CLOUDFRONT_SHARED_SECRET/);
	assert.match(rules('backend/.env.development', 'CFM_TOKEN=abc'), /CFM_TOKEN/);
	assert.deepEqual(checkEnvFile('backend/.env.development', 'CFM_TOKEN=\nAUTH_CODE_KEY=dev-only-x\n'), []);
	for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) {
		const f = checkEnvFile('backend/.env.development', `${k}=dev-only-x`);
		assert.equal(f.length, 1, k);
		assert.match(f[0].rule, /must not be committed/);
	}
	// Not secret-named: a key that merely contains KEY.
	assert.deepEqual(checkEnvFile('backend/.env.development', 'KEYBOARD_LAYOUT=us\nMONKEY_COUNT=3\n'), []);
});

test('data sources stay local and their paths stay inside the workspace', () => {
	assert.match(rules('backend/.env.development', 'CHIRPS_SOURCE=s3'), /CHIRPS_SOURCE must be local/);
	assert.match(rules('backend/.env.development', 'MAP_GRID_SOURCE=s3://bucket/key'), /MAP_GRID_SOURCE must be local/);
	assert.match(rules('backend/.env.development', 'CFM_SOURCE=cfm'), /CFM_SOURCE must be local/);
	for (const p of ['/home/someone/data', '~/data', '../pitman-private/x', 'C:\\data', '']) { // noqa: machine-path (a refused value under test, not a path this code reads)
		assert.match(rules('backend/.env.development', `DEM_LOCAL_FILE=${p}`), /relative path inside the workspace/, p);
	}
});

test('sign-in stays on the laptop', () => {
	assert.match(rules('backend/.env.development', 'USER_STORE=ddb'), /USER_STORE must be memory or dynamodb/);
	assert.match(rules('backend/.env.development', 'USERS_TABLE=pitman-users'), /-local table/);
	assert.match(rules('backend/.env.development', 'MAIL_TRANSPORT=ses'), /SES sends real mail/);
	assert.match(rules('backend/.env.development', 'MAIL_QUEUE=sqs'), /MAIL_QUEUE must be inline/);
	assert.match(rules('backend/.env.development', 'MAIL_QUEUE_URL=https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-send'), /MAIL_QUEUE_URL must not be set/);
	assert.deepEqual(checkEnvFile('backend/.env.development', 'MAIL_QUEUE=inline\nMAIL_QUEUE_URL=\n'), []);
});

test('frontend env files hold PUBLIC_* keys only, with the API on same-origin /api', () => {
	const ok = 'PUBLIC_API_URL=/api\nPUBLIC_SITE_URL=http://localhost:7777\nPUBLIC_TILES_URL=\n';
	assert.deepEqual(checkEnvFile('frontend/.env.development', ok), []);
	const f = checkEnvFile('frontend/.env.development', `${ok}AUTH_SESSION_KEY=dev-only-x\n`);
	assert.equal(f.length, 1);
	assert.match(f[0].rule, /not a PUBLIC_\* key/);
	assert.match(rules('frontend/.env.development', 'PUBLIC_API_URL=http://localhost:3001'), /same-origin \/api/);
	assert.match(rules('frontend/.env.development', 'PUBLIC_TILES_URL=https://tiles.example.org/x.pmtiles'), /non-local host/);
});

test('an .env.example is held to the frontend key rule but not the dev-default rules', () => {
	assert.deepEqual(checkEnvFile('backend/.env.example', 'CHIRPS_SOURCE=s3\nSITE_URL=https://pitman.jaredhoward.com\n'), []);
	assert.match(rules('frontend/.env.example', 'SECRET=x'), /not a PUBLIC_\* key/);
});
