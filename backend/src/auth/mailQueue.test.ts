// The sign-in mail queue's message (issue #30): sealed so nothing that reads the queue sees an address or a
// code, one size for a real message and a decoy, unreadable under another key or when tampered with; the
// in-process queue (local dev) delivers after the request; the SQS queue sends the body and nothing else;
// and the dispatch test that tells this queue's batches from the bounce queue's.
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';
import { eventsLogged, guardLogs } from '../__tests__/logGuard.js';
import { testClock } from '../__tests__/session.js';
import type { SignInMail } from './mail.js';
import { deliverSealed, fromQueue, inlineMailQueue, mailSealer, SEALED_PLAINTEXT_BYTES, SQS_CLIENT_OPTIONS, sqsClient, sqsMailQueue, type QueuedMail } from './mailQueue.js';

guardLogs();

const KEY = 'dev-only-code-key-0123456789abcdef';
const NOW = Date.parse('2026-11-07T08:00:00Z');
const MAIL: QueuedMail = { to: 'admin@example.test', code: '012345', expiresAt: NOW + 600_000, userId: 'u-1' };

describe('mailSealer', () => {
	const sealer = mailSealer(KEY);

	it('round-trips a message and a decoy, and shows neither the address nor the code', () => {
		const body = sealer.seal(MAIL);
		expect(sealer.open(body)).toEqual({ kind: 'mail', mail: MAIL });
		expect(sealer.open(sealer.seal(null))).toEqual({ kind: 'decoy' });
		expect(body).not.toContain('example.test');
		expect(body).not.toContain('012345');
		expect(body).not.toContain('u-1');
	});

	it('seals a real message, a decoy and the longest address to the same length, with a fresh IV each time', () => {
		const longest = { ...MAIL, to: `${'a'.repeat(64)}@${'b'.repeat(184)}.test`, code: '01234567', userId: 'f'.repeat(64) };
		expect(longest.to).toHaveLength(254);
		const bodies = [sealer.seal(MAIL), sealer.seal(null), sealer.seal(longest), sealer.seal(MAIL)];
		expect(new Set(bodies.map((b) => b.length)).size).toBe(1);
		expect(bodies[3]).not.toBe(bodies[0]);
		expect(sealer.open(bodies[2]!)).toEqual({ kind: 'mail', mail: longest });
	});

	it('refuses to seal more than fits, by a name that carries no address', () => {
		expect(() => sealer.seal({ ...MAIL, to: `${'a'.repeat(SEALED_PLAINTEXT_BYTES)}@example.test` })).toThrow(expect.objectContaining({ name: 'MailTooLong', message: expect.not.stringContaining('@') }));
	});

	it('cannot open a body under another key (AUTH_CODE_KEY rotated), tampered with, or not its own', () => {
		const body = sealer.seal(MAIL);
		expect(mailSealer(`${KEY}x`).open(body)).toEqual({ kind: 'unreadable' });
		const parsed = JSON.parse(body) as { v: number; iv: string; box: string };
		const box = Buffer.from(parsed.box, 'base64url');
		box[0] = box[0]! ^ 1;
		expect(sealer.open(JSON.stringify({ ...parsed, box: box.toString('base64url') }))).toEqual({ kind: 'unreadable' });
		for (const other of ['', 'not json', '{}', JSON.stringify({ ...parsed, v: 2 }), JSON.stringify({ ...parsed, iv: 'AA' }), JSON.stringify({ Type: 'Notification', Message: '{}' })]) {
			expect(sealer.open(other), other).toEqual({ kind: 'unreadable' });
		}
	});
});

describe('deliverSealed', () => {
	const sealer = mailSealer(KEY);
	const deps = (mail: (m: SignInMail) => Promise<void>, now = NOW) => ({ sealer, mail, clock: { now: () => now } });

	it('sends a live code, sends nothing for a decoy, and drops an expired code or an unreadable body with a log line', async () => {
		const sent: SignInMail[] = [];
		const mail = async (m: SignInMail) => void sent.push(m);
		expect(await deliverSealed(sealer.seal(MAIL), deps(mail))).toBe('sent');
		expect(await deliverSealed(sealer.seal(null), deps(mail))).toBe('decoy');
		expect(await deliverSealed(sealer.seal(MAIL), deps(mail, MAIL.expiresAt))).toBe('expired');
		expect(await deliverSealed('garbage', deps(mail))).toBe('unreadable');
		expect(sent).toEqual([{ to: MAIL.to, code: MAIL.code }]);
		expect(eventsLogged()).toEqual([{ event: 'mail.send_expired', userId: 'u-1' }, { event: 'mail.queue_unreadable' }]);
	});

	it('logs a refused send as mail.send_failed by user id and error name, never the message', async () => {
		const mail = async (m: SignInMail) => {
			throw Object.assign(new Error(`rejected ${m.to}`), { name: 'MessageRejected' });
		};
		expect(await deliverSealed(sealer.seal(MAIL), deps(mail))).toBe('failed');
		expect(eventsLogged()).toEqual([{ event: 'mail.send_failed', userId: 'u-1', error: 'MessageRejected' }]);
	});
});

describe('inlineMailQueue (local dev)', () => {
	it('answers before it delivers, then delivers the code through the same sealed path; a decoy sends nothing', async () => {
		const sent: SignInMail[] = [];
		const clock = testClock(NOW);
		const queue = inlineMailQueue({ sealer: mailSealer(KEY), mail: async (m) => void sent.push(m), clock });
		await queue.enqueue(MAIL);
		await queue.enqueue(null);
		expect(sent).toEqual([]);
		await vi.waitFor(() => expect(sent).toEqual([{ to: MAIL.to, code: MAIL.code }]));
	});
});

describe('sqsMailQueue', () => {
	it('sends the sealed body to the queue, with no attributes, and the same command shape for a decoy', async () => {
		const sent: SendMessageCommand[] = [];
		const client = { send: async (c: SendMessageCommand) => void sent.push(c) } as never;
		const sealer = mailSealer(KEY);
		const queueUrl = 'https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-send';
		const queue = sqsMailQueue({ queueUrl, sealer, client });
		await queue.enqueue(MAIL);
		await queue.enqueue(null);
		expect(sent.map((c) => Object.keys(c.input).sort())).toEqual([
			['MessageBody', 'QueueUrl'],
			['MessageBody', 'QueueUrl']
		]);
		expect(sent.map((c) => c.input.QueueUrl)).toEqual([queueUrl, queueUrl]);
		expect(sent[0]!.input.MessageBody!.length).toBe(sent[1]!.input.MessageBody!.length);
		expect(sealer.open(sent[0]!.input.MessageBody!)).toEqual({ kind: 'mail', mail: MAIL });
	});

	it('bounds the SQS client: 2 attempts, 0.5 s to connect and 1 s a request that throws when exceeded', async () => {
		expect(SQS_CLIENT_OPTIONS).toEqual({ maxAttempts: 2, requestHandler: { connectionTimeout: 500, requestTimeout: 1_000, throwOnRequestTimeout: true } });
		const client = sqsClient();
		expect(await client.config.maxAttempts()).toBe(2);
		client.destroy();
	});
});

describe('fromQueue', () => {
	const url = 'https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-send';

	it('matches a record from the queue by account and name, and nothing else', () => {
		expect(fromQueue({ eventSourceARN: 'arn:aws:sqs:af-south-1:111111111111:pitman-mail-send' }, url)).toBe(true);
		expect(fromQueue({ eventSourceARN: 'arn:aws:sqs:af-south-1:111111111111:pitman-mail-events' }, url)).toBe(false);
		expect(fromQueue({ eventSourceARN: 'arn:aws:sqs:af-south-1:222222222222:pitman-mail-send' }, url)).toBe(false);
		expect(fromQueue({ eventSourceARN: 'arn:aws:sqs:af-south-1:111111111111:pitman-mail-send-dlq' }, url)).toBe(false);
		expect(fromQueue({}, url)).toBe(false);
		expect(fromQueue(undefined, url)).toBe(false);
		expect(fromQueue({ eventSourceARN: 'arn:aws:sqs:af-south-1:111111111111:pitman-mail-send' }, undefined)).toBe(false);
		expect(fromQueue({ eventSourceARN: 'arn:aws:sqs:af-south-1:111111111111:pitman-mail-send' }, 'not a url')).toBe(false);
	});
});
