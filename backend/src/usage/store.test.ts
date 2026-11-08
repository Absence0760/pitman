// The usage store (decision R4-D7): local dev counts in memory with no setup, a Lambda is refused anything
// but DynamoDB (each instance would count on its own), and the DynamoDB store sends one conditional
// UpdateItem per use: the table's contract (`pk`, `expires_at`) and the only action the role allows.
import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { guardLogs } from '../__tests__/logGuard.js';
import { dynamoUsageStore, memoryUsageStore, readUsageConfig, usageStoreFromEnv } from './store.js';

guardLogs();

const LAMBDA = { AWS_LAMBDA_FUNCTION_NAME: 'pitman-backend' };

describe('readUsageConfig', () => {
	it('defaults local dev to memory, with nothing set', () => {
		expect(readUsageConfig({})).toEqual({ ok: true, config: { kind: 'memory' } });
		expect(readUsageConfig({ USAGE_STORE: 'dynamodb', USAGE_TABLE: 'pitman-usage-local', DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000' })).toEqual({
			ok: true,
			config: { kind: 'dynamodb', table: 'pitman-usage-local', endpoint: 'http://127.0.0.1:8000' }
		});
	});

	it('accepts DynamoDB on the Lambda', () => {
		expect(readUsageConfig({ ...LAMBDA, USAGE_STORE: 'dynamodb', USAGE_TABLE: 'pitman-usage' })).toEqual({ ok: true, config: { kind: 'dynamodb', table: 'pitman-usage' } });
	});

	it('fails closed on the Lambda with anything else, naming the variable', () => {
		expect(readUsageConfig(LAMBDA)).toEqual({ ok: false, problem: 'USAGE_STORE is not set (the Lambda needs dynamodb)' });
		expect(readUsageConfig({ ...LAMBDA, USAGE_STORE: 'memory' })).toEqual({ ok: false, problem: 'USAGE_STORE=memory is for local dev; the Lambda needs USAGE_STORE=dynamodb' });
		expect(readUsageConfig({ ...LAMBDA, USAGE_STORE: 'redis' })).toEqual({ ok: false, problem: 'USAGE_STORE must be memory or dynamodb' });
		expect(readUsageConfig({ ...LAMBDA, USAGE_STORE: 'dynamodb' })).toEqual({ ok: false, problem: 'USAGE_TABLE is not set' });
		expect(readUsageConfig({ ...LAMBDA, USAGE_STORE: 'dynamodb', USAGE_TABLE: 't', DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000' })).toEqual({
			ok: false,
			problem: 'DYNAMODB_ENDPOINT is for DynamoDB Local; the Lambda uses the regional endpoint'
		});
		expect(usageStoreFromEnv(LAMBDA)).toEqual({ problem: 'USAGE_STORE is not set (the Lambda needs dynamodb)' });
		expect(readUsageConfig({ USAGE_STORE: 'redis' })).toEqual({ ok: false, problem: 'USAGE_STORE must be memory or dynamodb' });
	});
});

describe('memoryUsageStore', () => {
	it('counts up to the limit per key, then refuses without counting', async () => {
		const s = memoryUsageStore(() => 0);
		expect(await s.take('a', 2, 100)).toBe(true);
		expect(await s.take('a', 2, 100)).toBe(true);
		expect(await s.take('a', 2, 100)).toBe(false);
		expect(await s.take('a', 3, 100)).toBe(true);
		expect(await s.take('b', 2, 100)).toBe(true);
	});

	it('forgets counts past their expiry when a new key arrives', async () => {
		let t = 0;
		const s = memoryUsageStore(() => t);
		await s.take('day-1', 1, 10);
		await s.take('day-1b', 1, 20);
		expect(s.size()).toBe(2);
		t = 15_000;
		await s.take('day-2', 1, 30);
		expect(s.size()).toBe(2);
	});
});

describe('dynamoUsageStore', () => {
	const fake = (answer: (input: unknown) => void) => {
		const sent: UpdateItemCommand[] = [];
		return {
			sent,
			client: {
				send: async (cmd: UpdateItemCommand) => {
					sent.push(cmd);
					answer(cmd.input);
					return {};
				}
			} as never
		};
	};

	it('sends one atomic UpdateItem: ADD the use, refuse past the limit, set the TTL', async () => {
		const f = fake(() => {});
		expect(await dynamoUsageStore({ client: f.client, table: 'pitman-usage' }).take('quota#chirps#u1#2026-11-07', 200, 1_762_646_400)).toBe(true);
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0]).toBeInstanceOf(UpdateItemCommand);
		expect(f.sent[0]!.input).toEqual({
			TableName: 'pitman-usage',
			Key: { pk: { S: 'quota#chirps#u1#2026-11-07' } },
			UpdateExpression: 'SET #expires = :expires ADD #uses :one',
			ConditionExpression: 'attribute_not_exists(#uses) OR #uses < :limit',
			ExpressionAttributeNames: { '#uses': 'uses', '#expires': 'expires_at' },
			ExpressionAttributeValues: { ':one': { N: '1' }, ':limit': { N: '200' }, ':expires': { N: '1762646400' } }
		});
	});

	it('reads a failed condition as the limit reached, and lets any other error through', async () => {
		const over = fake(() => {
			throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
		});
		expect(await dynamoUsageStore({ client: over.client, table: 't' }).take('k', 1, 1)).toBe(false);
		const down = fake(() => {
			throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
		});
		await expect(dynamoUsageStore({ client: down.client, table: 't' }).take('k', 1, 1)).rejects.toThrow('throttled');
	});
});
