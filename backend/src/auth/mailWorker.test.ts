// The mail queue's consumer (issue #30): a batch of sealed messages is sent at once, only refused sends are
// reported back for another try, decoys send nothing, and one counts-only line is logged per batch.
import type { SQSEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { eventsLogged, guardLogs } from '../__tests__/logGuard.js';
import { testAuth } from '../__tests__/session.js';
import { SES_SEND_WORST_CASE_MS } from './mail.js';
import { handleMailQueue } from './mailWorker.js';

guardLogs();

const ARN = 'arn:aws:sqs:af-south-1:111111111111:pitman-mail-send';
const batch = (...bodies: string[]): SQSEvent => ({ Records: bodies.map((body, i) => ({ eventSource: 'aws:sqs', eventSourceARN: ARN, messageId: `m${i}`, body }) as SQSEvent['Records'][number]) });

describe('handleMailQueue', () => {
	it('sends each live code, drops decoys, expired codes and unreadable bodies, and retries nothing that sent', async () => {
		const t = testAuth();
		const now = t.clock.now();
		const live = t.auth.sealer.seal({ to: 'admin@example.test', code: '012345', expiresAt: now + 600_000, userId: 'u-1' });
		const dead = t.auth.sealer.seal({ to: 'user@example.test', code: '999999', expiresAt: now - 1, userId: 'u-2' });
		const r = await handleMailQueue(batch(live, t.auth.sealer.seal(null), dead, 'garbage'), t.auth);
		expect(r).toEqual({ batchItemFailures: [] });
		expect(t.outbox).toEqual([{ to: 'admin@example.test', code: '012345' }]);
		expect(eventsLogged()).toEqual([
			{ event: 'mail.send_expired', userId: 'u-2' },
			{ event: 'mail.queue_unreadable' },
			{ event: 'mail.queue', records: 4, sent: 1, decoy: 1, expired: 1, unreadable: 1, failed: 0 }
		]);
	});

	it('reports a refused send back for SQS to redeliver, and logs mail.send_failed without the address', async () => {
		const t = testAuth({ mailFails: true });
		const body = t.auth.sealer.seal({ to: 'admin@example.test', code: '012345', expiresAt: t.clock.now() + 600_000, userId: 'u-1' });
		const r = await handleMailQueue(batch(t.auth.sealer.seal(null), body), t.auth);
		expect(r).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
		expect(eventsLogged()).toEqual([
			{ event: 'mail.send_failed', userId: 'u-1', error: 'MessageRejected' },
			{ event: 'mail.queue', records: 2, sent: 0, decoy: 1, expired: 0, unreadable: 0, failed: 1 }
		]);
	});

	it('redelivers the whole batch when sign-in is unconfigured, and says so', async () => {
		const r = await handleMailQueue(batch('a', 'b'), { ready: false, problem: 'AUTH_CODE_KEY is missing' });
		expect(r).toEqual({ batchItemFailures: [{ itemIdentifier: 'm0' }, { itemIdentifier: 'm1' }] });
		expect(eventsLogged()).toEqual([{ event: 'mail.queue_unsent', reason: 'sign-in is not configured', records: 2 }]);
	});

	it('sends a batch at once, so a batch lasts one SES worst case, far inside the shortest Lambda timeout (25 s)', async () => {
		const t = testAuth();
		let inFlight = 0;
		let most = 0;
		const auth = {
			...t.auth,
			mail: async () => {
				most = Math.max(most, ++inFlight);
				await Promise.resolve();
				inFlight--;
			}
		};
		const bodies = Array.from({ length: 10 }, (_, i) => t.auth.sealer.seal({ to: `u${i}@example.test`, code: '012345', expiresAt: t.clock.now() + 600_000, userId: `u-${i}` }));
		expect(await handleMailQueue(batch(...bodies), auth)).toEqual({ batchItemFailures: [] });
		expect(most).toBe(10);
		expect(SES_SEND_WORST_CASE_MS).toBeLessThan(25_000);
	});
});
