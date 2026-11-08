// Where the per-user daily counts live (decision R4-D7): in this process's memory for local dev and tests,
// in a DynamoDB table on the Lambda, so every instance draws on one count per user. Like sign-in's store
// (auth/config.ts, A-AUTH-8), a Lambda never falls back to memory: each instance would count on its own,
// and ten instances would give each user ten quotas. On a Lambda with anything but USAGE_STORE=dynamodb
// the costly routes answer 503 instead (usage/quota.ts).
import { ConditionalCheckFailedException, type DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { onLambda } from '../auth/config.js';
import { dynamoClient } from '../auth/store.js';

/** A count per key that refuses to pass a limit. */
export interface UsageStore {
	/**
	 * Counts one use of `key` unless it already has `limit`: true when counted, false when the limit was
	 * reached (and nothing was counted). `expiresAt` (epoch seconds) is when the count may be forgotten.
	 */
	take(key: string, limit: number, expiresAt: number): Promise<boolean>;
}

export type UsageConfig = { kind: 'memory' } | { kind: 'dynamodb'; table: string; endpoint?: string };
export type UsageConfigResult = { ok: true; config: UsageConfig } | { ok: false; problem: string };

type Env = Record<string, string | undefined>;

/** The store's settings, or what is wrong with them. A problem names the variable, never its value. */
export function readUsageConfig(env: Env): UsageConfigResult {
	const lambda = onLambda(env);
	const kind = env.USAGE_STORE || (lambda ? '' : 'memory');
	if (kind === 'memory') {
		if (lambda) return { ok: false, problem: 'USAGE_STORE=memory is for local dev; the Lambda needs USAGE_STORE=dynamodb' };
		return { ok: true, config: { kind: 'memory' } };
	}
	if (kind === 'dynamodb') {
		const table = env.USAGE_TABLE ?? '';
		if (!table) return { ok: false, problem: 'USAGE_TABLE is not set' };
		const endpoint = env.DYNAMODB_ENDPOINT || undefined;
		if (endpoint && lambda) return { ok: false, problem: 'DYNAMODB_ENDPOINT is for DynamoDB Local; the Lambda uses the regional endpoint' };
		return { ok: true, config: endpoint ? { kind: 'dynamodb', table, endpoint } : { kind: 'dynamodb', table } };
	}
	return { ok: false, problem: kind ? 'USAGE_STORE must be memory or dynamodb' : 'USAGE_STORE is not set (the Lambda needs dynamodb)' };
}

/** Counts in this process: local dev and tests. Expired counts are dropped as new ones arrive. */
export function memoryUsageStore(now: () => number = Date.now): UsageStore & { size(): number } {
	const counts = new Map<string, { uses: number; expiresAt: number }>();
	return {
		async take(key, limit, expiresAt) {
			const t = now() / 1000;
			// Keys are per user per day, so the map is small; a sweep when a new key arrives keeps it so.
			if (!counts.has(key)) for (const [k, v] of counts) if (v.expiresAt <= t) counts.delete(k);
			const c = counts.get(key) ?? { uses: 0, expiresAt };
			if (c.uses >= limit) return false;
			c.uses++;
			counts.set(key, c);
			return true;
		},
		size: () => counts.size
	};
}

/** The usage table's attributes (the Terraform side's contract): hash key `pk` (S), TTL `expires_at` (N, epoch seconds). */
export const USAGE_ATTRIBUTES = { key: 'pk', uses: 'uses', expiresAt: 'expires_at' } as const;

/**
 * Counts in DynamoDB: one conditional UpdateItem per use, so the check and the increment are one atomic call and
 * two instances can never both take the last use. The Lambda's role has only `dynamodb:UpdateItem` on the table.
 */
export function dynamoUsageStore(opts: { client: Pick<DynamoDBClient, 'send'>; table: string }): UsageStore {
	return {
		async take(key, limit, expiresAt) {
			try {
				await opts.client.send(
					new UpdateItemCommand({
						TableName: opts.table,
						Key: { [USAGE_ATTRIBUTES.key]: { S: key } },
						UpdateExpression: 'SET #expires = :expires ADD #uses :one',
						ConditionExpression: 'attribute_not_exists(#uses) OR #uses < :limit',
						ExpressionAttributeNames: { '#uses': USAGE_ATTRIBUTES.uses, '#expires': USAGE_ATTRIBUTES.expiresAt },
						ExpressionAttributeValues: { ':one': { N: '1' }, ':limit': { N: String(limit) }, ':expires': { N: String(expiresAt) } }
					})
				);
				return true;
			} catch (err) {
				if (err instanceof ConditionalCheckFailedException || (err as { name?: unknown })?.name === 'ConditionalCheckFailedException') return false;
				throw err;
			}
		}
	};
}

/** The store the environment names, or why there is none. */
export function usageStoreFromEnv(env: Env): UsageStore | { problem: string } {
	const r = readUsageConfig(env);
	if (!r.ok) return { problem: r.problem };
	if (r.config.kind === 'memory') return memoryUsageStore();
	return dynamoUsageStore({ client: dynamoClient(r.config.endpoint), table: r.config.table });
}
