// Sign-in's settings: local dev works with no setup beyond .env.development, and a Lambda with any gap
// is refused (the app then answers 503, routes.test.ts). A problem names the variable, never its value.
import { describe, expect, it } from 'vitest';
import { guardLogs } from '../__tests__/logGuard.js';
import { readAuthConfig } from './config.js';
import { authRuntimeFromEnv } from './runtime.js';

guardLogs();

const CODE = 'dev-only-code-key-0123456789abcdef';
const SESSION = 'dev-only-session-key-0123456789abc';
const LAMBDA = {
	AWS_LAMBDA_FUNCTION_NAME: 'pitman-backend',
	USER_STORE: 'dynamodb',
	USERS_TABLE: 'pitman-users',
	MAIL_TRANSPORT: 'ses',
	MAIL_FROM: 'Pitman <no-reply@example.test>',
	SES_CONFIGURATION_SET: 'pitman',
	MAIL_QUEUE: 'sqs',
	MAIL_QUEUE_URL: 'https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-send',
	AUTH_CODE_KEY: CODE,
	AUTH_SESSION_KEY: SESSION
};

describe('readAuthConfig', () => {
	it('defaults local dev to the memory store, console mail and the in-process mail queue', () => {
		expect(readAuthConfig({ AUTH_CODE_KEY: CODE, AUTH_SESSION_KEY: SESSION })).toEqual({
			ok: true,
			config: { store: { kind: 'memory' }, codeKey: CODE, sessionKey: SESSION, mail: { kind: 'console', from: 'Pitman <no-reply@localhost>' }, queue: { kind: 'inline' }, devCookie: false }
		});
		expect(readAuthConfig({ AUTH_CODE_KEY: CODE, AUTH_SESSION_KEY: SESSION, USER_STORE: 'dynamodb', USERS_TABLE: 't', DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000', MAIL_TRANSPORT: 'smtp', SMTP_PORT: '1025', AUTH_DEV_COOKIE: 'true' })).toMatchObject({
			ok: true,
			config: { store: { kind: 'dynamodb', table: 't', endpoint: 'http://127.0.0.1:8000' }, mail: { kind: 'smtp', host: '127.0.0.1', port: 1025 }, devCookie: true }
		});
	});

	it('accepts a complete Lambda configuration', () => {
		expect(readAuthConfig(LAMBDA)).toEqual({
			ok: true,
			config: { store: { kind: 'dynamodb', table: 'pitman-users' }, codeKey: CODE, sessionKey: SESSION, mail: { kind: 'ses', from: LAMBDA.MAIL_FROM, configurationSet: 'pitman' }, queue: { kind: 'sqs', url: LAMBDA.MAIL_QUEUE_URL }, devCookie: false }
		});
	});

	it.each([
		[{ AUTH_CODE_KEY: undefined }, 'AUTH_CODE_KEY is missing'],
		[{ AUTH_CODE_KEY: 'x'.repeat(31) }, 'AUTH_CODE_KEY is missing or shorter than 32'],
		[{ AUTH_SESSION_KEY: '' }, 'AUTH_SESSION_KEY is missing'],
		[{ AUTH_SESSION_KEY: CODE }, 'must be different'],
		[{ USER_STORE: undefined }, 'USER_STORE is not set'],
		[{ USER_STORE: 'memory' }, 'USER_STORE=memory is for local dev'],
		[{ USER_STORE: 'postgres' }, 'USER_STORE must be memory or dynamodb'],
		[{ USERS_TABLE: undefined }, 'USERS_TABLE is not set'],
		[{ DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000' }, 'DYNAMODB_ENDPOINT is for DynamoDB Local'],
		[{ MAIL_TRANSPORT: undefined }, 'MAIL_TRANSPORT is not set'],
		[{ MAIL_TRANSPORT: 'console' }, 'MAIL_TRANSPORT=console is for local dev'],
		[{ MAIL_TRANSPORT: 'smtp' }, 'MAIL_TRANSPORT=smtp is for local dev'],
		[{ MAIL_FROM: undefined }, 'MAIL_FROM is not set'],
		[{ SES_CONFIGURATION_SET: undefined }, 'SES_CONFIGURATION_SET is not set'],
		[{ MAIL_QUEUE: undefined }, 'MAIL_QUEUE is not set'],
		[{ MAIL_QUEUE: 'inline' }, 'MAIL_QUEUE=inline is for local dev'],
		[{ MAIL_QUEUE: 'kafka' }, 'MAIL_QUEUE must be inline or sqs'],
		[{ MAIL_QUEUE_URL: undefined }, 'MAIL_QUEUE_URL is not set'],
		[{ MAIL_QUEUE_URL: 'http://127.0.0.1:4566/000000000000/pitman-mail-send' }, 'MAIL_QUEUE_URL is not an SQS queue URL'],
		[{ MAIL_QUEUE_URL: 'https://sqs.af-south-1.amazonaws.com/111111111111/a b' }, 'MAIL_QUEUE_URL is not an SQS queue URL'],
		[{ AUTH_DEV_COOKIE: 'true' }, 'AUTH_DEV_COOKIE is for local dev']
	])('refuses a Lambda with %o', (gap, problem) => {
		const r = readAuthConfig({ ...LAMBDA, ...gap });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.problem).toContain(problem);
			expect(r.problem).not.toContain(CODE);
			expect(r.problem).not.toContain(SESSION);
		}
	});

	it('refuses a port that is not one, and a transport it doesn’t know', () => {
		expect(readAuthConfig({ AUTH_CODE_KEY: CODE, AUTH_SESSION_KEY: SESSION, MAIL_TRANSPORT: 'smtp', SMTP_PORT: '99999' })).toEqual({ ok: false, problem: 'SMTP_PORT is not a port number' });
		expect(readAuthConfig({ AUTH_CODE_KEY: CODE, AUTH_SESSION_KEY: SESSION, MAIL_TRANSPORT: 'pigeon' })).toEqual({ ok: false, problem: 'MAIL_TRANSPORT must be console, smtp or ses' });
	});
});

describe('authRuntimeFromEnv', () => {
	it('builds the __Host- cookie on a Lambda, whatever else is set', () => {
		const runtime = authRuntimeFromEnv(LAMBDA);
		expect(runtime.ready && runtime.cookie.name).toBe('__Host-pitman_session');
	});

	it('refuses SMTP unless the dev server supplied the transport', () => {
		const env = { AUTH_CODE_KEY: CODE, AUTH_SESSION_KEY: SESSION, MAIL_TRANSPORT: 'smtp' };
		expect(authRuntimeFromEnv(env)).toEqual({ ready: false, problem: 'MAIL_TRANSPORT=smtp is available only from the local dev server' });
		expect(authRuntimeFromEnv(env, { smtp: () => async () => {} }).ready).toBe(true);
	});
});
