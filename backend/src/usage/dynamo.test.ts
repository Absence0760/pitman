// The usage store against DynamoDB Local (`pnpm dev:auth:up`, then DYNAMODB_ENDPOINT=http://127.0.0.1:8000
// pnpm backend test; CI runs it): a table of the Terraform side's shape (hash key `pk`, TTL `expires_at`), the
// conditional UpdateItem under real concurrency (exactly `limit` of many simultaneous takes succeed), and the
// TTL attribute written. Skips, saying so, when DYNAMODB_ENDPOINT is unset.
import { CreateTableCommand, DeleteTableCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';
import { dynamoClient } from '../auth/store.js';
import { dynamoUsageStore } from './store.js';

const endpoint = process.env.DYNAMODB_ENDPOINT;
if (!endpoint) console.warn('usage/dynamo.test.ts skipped: DYNAMODB_ENDPOINT is unset (pnpm dev:auth:up, then DYNAMODB_ENDPOINT=http://127.0.0.1:8000)');

describe.skipIf(!endpoint)('usage counts on DynamoDB Local', () => {
	const client = dynamoClient(endpoint);
	const tables: string[] = [];
	afterAll(async () => {
		for (const t of tables) await client.send(new DeleteTableCommand({ TableName: t })).catch(() => undefined);
	});

	async function table() {
		const name = `pitman-usage-test-${crypto.randomUUID()}`;
		await client.send(
			new CreateTableCommand({ TableName: name, BillingMode: 'PAY_PER_REQUEST', AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }] })
		);
		tables.push(name);
		return name;
	}

	it('lets exactly `limit` of many simultaneous uses through, and writes the count and its expiry', async () => {
		const name = await table();
		const store = dynamoUsageStore({ client, table: name });
		const results = await Promise.all(Array.from({ length: 25 }, () => store.take('quota#chirps#u1#2026-11-07', 10, 1_762_646_400)));
		expect(results.filter(Boolean)).toHaveLength(10);
		const item = await client.send(new GetItemCommand({ TableName: name, Key: { pk: { S: 'quota#chirps#u1#2026-11-07' } } }));
		expect(item.Item).toEqual({ pk: { S: 'quota#chirps#u1#2026-11-07' }, uses: { N: '10' }, expires_at: { N: '1762646400' } });
		// Another key (another user, or tomorrow) has its own count.
		expect(await store.take('quota#chirps#u1#2026-11-08', 10, 1_762_732_800)).toBe(true);
	}, 20_000);
});
