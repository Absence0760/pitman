// The sign-in email, off the request path (issue #30, A-AUTH-14). POST /auth/code no longer sends mail:
// it puts one sealed message on a queue, for a listed address and an unlisted one alike, and returns.
// Whatever reads the queue (the SQS worker in mailWorker.ts, or the in-process queue in local dev) opens
// the message and sends the code through the configured Mailer (mail.ts).
//
//   inline  local dev default (MAIL_QUEUE=inline). The same sealed message, opened and delivered in this
//           process just after the request answers; nothing to run, no AWS. Refused on Lambda, which
//           freezes once it has answered, so a deferred send could be lost.
//   sqs     the Lambda (MAIL_QUEUE=sqs, MAIL_QUEUE_URL). SQS SendMessage; the same Lambda consumes the
//           queue through an event source mapping (infra/mail_queue.tf).
//
// The message is sealed, not merely SSE-encrypted: AES-256-GCM under a key derived (HKDF) from
// AUTH_CODE_KEY, with the plaintext padded to a fixed size. So the body never shows an address or a code
// to anything that can read the queue (the console, a DLQ redrive, a log), a decoy is the same size as a
// real message, and rotating AUTH_CODE_KEY, which already voids every live code, also voids every queued
// message. Nothing logs a body.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Clock } from '@absence0760/auth-kit';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { errorSummary } from '../http/logError.js';
import type { Mailer } from './mail.js';

const logEvent = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));

/** One sign-in email to send: the address, the code, when the code expires and whose it is. */
export interface QueuedMail {
	to: string;
	code: string;
	expiresAt: number;
	userId: string;
}

/**
 * The request side. `null` is the decoy an unlisted address enqueues, so both do the same work: one
 * message, of one size, on one queue. A queue throws on failure; the route logs it and still answers 202.
 */
export interface MailQueue {
	enqueue(mail: QueuedMail | null): Promise<void>;
}

/** What a sealed message turned out to hold. */
export type Opened = { kind: 'mail'; mail: QueuedMail } | { kind: 'decoy' } | { kind: 'unreadable' };

export interface MailSealer {
	seal(mail: QueuedMail | null): string;
	open(body: string): Opened;
}

/** The label the key is derived under and the GCM associated data: a new layout gets a new label. */
const LABEL = 'pitman/sign-in-mail-queue/v1';
/**
 * Every plaintext is padded to this many bytes, so a real message and a decoy seal to the same length.
 * The longest real one: auth-kit's 254-character address limit (MAX_EMAIL_LENGTH), 8 digits, a 13-digit
 * time, its user id and the JSON around them, well under this.
 */
export const SEALED_PLAINTEXT_BYTES = 512;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM over a padded JSON plaintext, keyed from AUTH_CODE_KEY by HKDF-SHA256 with its own label. */
export function mailSealer(codeKey: string): MailSealer {
	const key = Buffer.from(hkdfSync('sha256', codeKey, 'pitman', LABEL, 32));
	const aad = Buffer.from(LABEL);
	return {
		seal(mail) {
			const json = Buffer.from(JSON.stringify(mail ? { t: 'mail', ...mail } : { t: 'decoy' }), 'utf8');
			// Never by the address: the error's message reaches the route's log only by name anyway.
			if (json.length > SEALED_PLAINTEXT_BYTES) throw Object.assign(new Error('the sign-in mail is too long to seal'), { name: 'MailTooLong' });
			const plain = Buffer.alloc(SEALED_PLAINTEXT_BYTES, 0x20);
			json.copy(plain);
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv('aes-256-gcm', key, iv);
			cipher.setAAD(aad);
			const box = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
			return JSON.stringify({ v: 1, iv: iv.toString('base64url'), box: box.toString('base64url') });
		},
		open(body) {
			try {
				const outer: unknown = JSON.parse(body);
				if (!outer || typeof outer !== 'object') return { kind: 'unreadable' };
				const { v, iv, box } = outer as Record<string, unknown>;
				if (v !== 1 || typeof iv !== 'string' || typeof box !== 'string') return { kind: 'unreadable' };
				const ivBytes = Buffer.from(iv, 'base64url');
				const boxBytes = Buffer.from(box, 'base64url');
				if (ivBytes.length !== IV_BYTES || boxBytes.length !== SEALED_PLAINTEXT_BYTES + TAG_BYTES) return { kind: 'unreadable' };
				const decipher = createDecipheriv('aes-256-gcm', key, ivBytes);
				decipher.setAAD(aad);
				decipher.setAuthTag(boxBytes.subarray(SEALED_PLAINTEXT_BYTES));
				const plain = Buffer.concat([decipher.update(boxBytes.subarray(0, SEALED_PLAINTEXT_BYTES)), decipher.final()]);
				const inner: unknown = JSON.parse(plain.toString('utf8'));
				if (!inner || typeof inner !== 'object') return { kind: 'unreadable' };
				const m = inner as Record<string, unknown>;
				if (m.t === 'decoy') return { kind: 'decoy' };
				if (m.t === 'mail' && typeof m.to === 'string' && typeof m.code === 'string' && typeof m.expiresAt === 'number' && typeof m.userId === 'string') {
					return { kind: 'mail', mail: { to: m.to, code: m.code, expiresAt: m.expiresAt, userId: m.userId } };
				}
				return { kind: 'unreadable' };
			} catch {
				// Not JSON, a wrong key (AUTH_CODE_KEY rotated) or a tampered box: GCM refuses all three.
				return { kind: 'unreadable' };
			}
		}
	};
}

/** What delivering one sealed message came to. Only `failed` is worth another try. */
export type DeliveryOutcome = 'sent' | 'decoy' | 'expired' | 'unreadable' | 'failed';

export interface DeliveryDeps {
	sealer: MailSealer;
	mail: Mailer;
	clock: Clock;
}

/**
 * Opens one message and sends its code. A decoy sends nothing. A code that has expired is not sent (a
 * redelivery or a backlog can't mail a dead code). Logs, by user id and error name only (A-AUTH-11):
 * `mail.send_failed` when the transport throws, `mail.send_expired`, `mail.queue_unreadable`.
 */
export async function deliverSealed(body: string, deps: DeliveryDeps): Promise<DeliveryOutcome> {
	const opened = deps.sealer.open(body);
	if (opened.kind === 'decoy') return 'decoy';
	if (opened.kind === 'unreadable') {
		logEvent({ event: 'mail.queue_unreadable' });
		return 'unreadable';
	}
	const { mail } = opened;
	if (deps.clock.now() >= mail.expiresAt) {
		logEvent({ event: 'mail.send_expired', userId: mail.userId });
		return 'expired';
	}
	try {
		await deps.mail({ to: mail.to, code: mail.code });
		return 'sent';
	} catch (e) {
		// The error's name only: SES puts the recipient in its messages.
		logEvent({ event: 'mail.send_failed', userId: mail.userId, ...errorSummary(e) });
		return 'failed';
	}
}

/**
 * Local dev: seals the message exactly as the Lambda does, then opens and delivers it in this process once
 * the request has answered (`setImmediate`). `wait: true` delivers before enqueue returns instead, for tests
 * that read the outbox straight after a request.
 */
export function inlineMailQueue(deps: DeliveryDeps & { wait?: boolean }): MailQueue {
	return {
		async enqueue(mail) {
			const body = deps.sealer.seal(mail);
			if (deps.wait) {
				await deliverSealed(body, deps);
				return;
			}
			setImmediate(() => void deliverSealed(body, deps));
		}
	};
}

/**
 * The SQS client's bounds. The send runs inside /auth/code's floor, and for a listed and an unlisted
 * address alike, so a slow SQS can't tell them apart; the bounds only keep a stalled SQS from holding the
 * request for the SDK's defaults (3 attempts, no request timeout). `throwOnRequestTimeout` makes
 * `requestTimeout` a bound rather than a logged warning (see SES_CLIENT_OPTIONS in mail.ts).
 */
export const SQS_CLIENT_OPTIONS = { maxAttempts: 2, requestHandler: { connectionTimeout: 500, requestTimeout: 1_000, throwOnRequestTimeout: true } } as const;

export const sqsClient = () => new SQSClient({ ...SQS_CLIENT_OPTIONS, requestHandler: { ...SQS_CLIENT_OPTIONS.requestHandler } });

/** The Lambda's queue: one SendMessage per request, the sealed body and nothing else (no attributes). */
export function sqsMailQueue(options: { queueUrl: string; sealer: MailSealer; client?: Pick<SQSClient, 'send'> }): MailQueue {
	const client = options.client ?? sqsClient();
	return {
		async enqueue(mail) {
			await client.send(new SendMessageCommand({ QueueUrl: options.queueUrl, MessageBody: options.sealer.seal(mail) }));
		}
	};
}

/**
 * True when an SQS record came from the queue at `queueUrl` (`https://sqs.<region>.amazonaws.com/<account>/<name>`):
 * the record's `eventSourceARN` ends `:<account>:<name>`. Lambda's SQS batches each come from one mapping,
 * so lambda.ts dispatches a batch on its first record.
 */
export function fromQueue(record: { eventSourceARN?: unknown } | undefined, queueUrl: string | undefined): boolean {
	if (!record || !queueUrl || typeof record.eventSourceARN !== 'string') return false;
	const m = /^https:\/\/[^/]+\/(\d{12})\/([A-Za-z0-9_-]{1,80})$/.exec(queueUrl);
	if (!m) return false;
	const arn = record.eventSourceARN.split(':');
	return arn.length === 6 && arn[0] === 'arn' && arn[2] === 'sqs' && arn[4] === m[1] && arn[5] === m[2];
}
