// Pitman's wiring against DynamoDB Local (`pnpm dev:auth:up`, then DYNAMODB_ENDPOINT=http://127.0.0.1:8000
// pnpm backend test): the P4 races through the real routes and the real store, with real concurrency.
// auth-kit's contract suite proves the store's rules; this proves pitman reaches them and answers with
// their outcome. Skips, saying so, when DYNAMODB_ENDPOINT is unset.
import { cryptoRandom, randomSecret, type UserRecord } from '@absence0760/auth-kit';
import { dynamoStore, tableDefinition } from '@absence0760/auth-kit/dynamodb';
import { CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { main as bootstrapScript } from '../../scripts/bootstrap-admin.js';
import { guardLogs } from '../__tests__/logGuard.js';
import { TEST_ORIGIN } from '../__tests__/session.js';
import { handleMailEvents } from './mailEvents.js';
import { createAuthRuntime, type AuthReady } from './runtime.js';
import { dynamoClient } from './store.js';
import { Readable, Writable } from 'node:stream';

const endpoint = process.env.DYNAMODB_ENDPOINT;
if (!endpoint) console.warn('auth/dynamo.test.ts skipped: DYNAMODB_ENDPOINT is unset (pnpm dev:auth:up, then DYNAMODB_ENDPOINT=http://127.0.0.1:8000)');

describe.skipIf(!endpoint)('sign-in on DynamoDB Local', () => {
	guardLogs();
	const many = { limit: 100_000, windowMs: 60_000 };
	const client = dynamoClient(endpoint);
	const tables: string[] = [];

	afterAll(async () => {
		for (const t of tables) await client.send(new DeleteTableCommand({ TableName: t })).catch(() => undefined);
	});

	async function setUp() {
		const tableName = `pitman-test-${crypto.randomUUID()}`;
		await client.send(new CreateTableCommand(tableDefinition(tableName)));
		tables.push(tableName);
		const store = dynamoStore({ client, tableName });
		const auth = createAuthRuntime({ store, codeKey: randomSecret(cryptoRandom), sessionKey: randomSecret(cryptoRandom), mail: async () => {} }) as AuthReady;
		const a = createApp({ auth, rateLimits: { chirps: many, mapGrid: many, auth: many } });
		const as = async (user: UserRecord) => {
			const cookie = `${auth.cookie.name}=${(await auth.kit.issueSession(user)).token}`;
			const req = (method: string, path: string, body?: unknown) =>
				a.request(path, { method, headers: { origin: TEST_ORIGIN, cookie, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
			return req;
		};
		const boot = await auth.kit.bootstrapAdmin('admin@example.test');
		if (!boot.ok) throw new Error(boot.error);
		const add = async (email: string, isAdmin: boolean) => {
			const r = await auth.kit.addUser(boot.value, email, isAdmin);
			if (!r.ok) throw new Error(r.error);
			return r.value;
		};
		const auditCount = async () => (await store.listAudit(1000)).length;
		return { tableName, store, auth, as, admin: boot.value, add, auditCount };
	}

	it('two admins demoting each other at once: exactly one succeeds, one admin is left', async () => {
		const { store, as, admin, add, auditCount } = await setUp();
		const second = await add('second@example.test', true);
		const [a, b] = [await as(admin), await as(second)];
		const rows = await auditCount();
		const answers = await Promise.all([a('PATCH', `/users/${second.id}`, { isAdmin: false }), b('PATCH', `/users/${admin.id}`, { isAdmin: false })]);
		expect(answers.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
		for (const r of answers) expect([200, 403, 409]).toContain(r.status);
		expect(await store.adminCount()).toBe(1);
		expect(await auditCount()).toBe(rows + 1);
	}, 20_000);

	it('two admins demoting the same third at once: the count stays exact and one change is recorded', async () => {
		const { store, as, admin, add, auditCount } = await setUp();
		const second = await add('second@example.test', true);
		const third = await add('third@example.test', true);
		const rows = await auditCount();
		const answers = await Promise.all([(await as(admin))('PATCH', `/users/${third.id}`, { isAdmin: false }), (await as(second))('PATCH', `/users/${third.id}`, { isAdmin: false })]);
		for (const r of answers) expect([200, 409]).toContain(r.status);
		expect((await store.getUser(third.id))?.isAdmin).toBe(false);
		expect(await store.adminCount()).toBe(2);
		expect(await auditCount()).toBe(rows + 1);
	}, 20_000);

	it('a removed user’s next request gets 401, and removing yourself is refused', async () => {
		const { as, admin, add } = await setUp();
		const user = await add('user@example.test', false);
		const them = await as(user);
		expect((await them('GET', '/auth/me')).status).toBe(200);
		const api = await as(admin);
		expect((await api('DELETE', `/users/${admin.id}`)).status).toBe(400);
		expect((await api('DELETE', `/users/${user.id}`)).status).toBe(204);
		expect((await them('GET', '/auth/me')).status).toBe(401);
	}, 20_000);

	it('two bootstrap runs at once: exactly one succeeds', async () => {
		const tableName = `pitman-test-${crypto.randomUUID()}`;
		await client.send(new CreateTableCommand(tableDefinition(tableName)));
		tables.push(tableName);
		const store = dynamoStore({ client, tableName });
		const auth = createAuthRuntime({ store, codeKey: randomSecret(cryptoRandom), sessionKey: randomSecret(cryptoRandom), mail: async () => {} }) as AuthReady;
		const getKit = async () => ({ kit: auth.kit, where: tableName });
		const run = (email: string) =>
			bootstrapScript(
				{
					stdin: Readable.from([`${email}\n`]),
					stdout: new Writable({ write: (_c, _e, done) => done() }),
					args: []
				},
				getKit
			);
		const codes = await Promise.all([run('one@example.test'), run('two@example.test')]);
		expect(codes.sort()).toEqual([0, 1]);
		expect((await store.listUsers()).length).toBe(1);
		expect(await store.adminCount()).toBe(1);
	}, 20_000);

	it('writes audit rows with a TTL 24 months out', async () => {
		const { store, admin } = await setUp();
		const [row] = await store.listAudit(1);
		const at = new Date(row!.at);
		const expires = new Date(row!.expiresAt * 1000);
		expect(row!.actor).toBe('operator');
		expect((expires.getUTCFullYear() - at.getUTCFullYear()) * 12 + expires.getUTCMonth() - at.getUTCMonth()).toBe(24);
		expect(admin.isAdmin).toBe(true);
	}, 20_000);
	it('a permanent bounce from SQS flags the user on the real store, and an admin clears it through the route', async () => {
		const { auth, as, admin, add } = await setUp();
		const user = await add('bounced@example.test', false);
		// After the user was added, before the clear below (events are ordered by time).
		const at = new Date(Math.max(Date.now(), Date.parse(user.addedAt))).toISOString();
		const body = JSON.stringify({ Type: 'Notification', Message: JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', timestamp: at, bouncedRecipients: [{ emailAddress: user.email }] } }) });
		const event = { Records: [{ eventSource: 'aws:sqs', messageId: 'm0', body }] } as never;
		expect(await handleMailEvents(event, auth)).toEqual({ batchItemFailures: [] });
		// Redelivered: unchanged, still no failure.
		expect(await handleMailEvents(event, auth)).toEqual({ batchItemFailures: [] });
		const req = await as(admin);
		const users = (await (await req('GET', '/users')).json()) as { users: { id: string; undeliverable: unknown }[] };
		expect(users.users.find((u) => u.id === user.id)!.undeliverable).toEqual({ kind: 'bounce', at });
		const cleared = await req('POST', `/users/${user.id}/clear-delivery-problem`, {});
		expect(cleared.status).toBe(200);
		expect(await cleared.json()).toEqual({ user: expect.objectContaining({ id: user.id, undeliverable: null }) });
		// The same event again is from before the clear: it stays cleared.
		expect(await handleMailEvents(event, auth)).toEqual({ batchItemFailures: [] });
		const after = (await (await req('GET', '/users')).json()) as { users: { id: string; undeliverable: unknown }[] };
		expect(after.users.find((u) => u.id === user.id)!.undeliverable).toBeNull();
	});
});
