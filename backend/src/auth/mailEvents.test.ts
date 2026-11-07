// SES bounce and complaint notifications (SQS of SNS of SES): permanent bounces and complaints flag the
// listed user through auth-kit's recordDeliveryProblem, at the event's time; a 409 or a store error is
// redelivered; nothing logs an address.
import type { Result } from '@absence0760/auth-kit';
import type { SQSEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { eventsLogged, guardLogs } from '../__tests__/logGuard.js';
import { ADMIN, bootstrap, testAuth } from '../__tests__/session.js';
import { handleMailEvents, isSqsEvent } from './mailEvents.js';
import type { AuthRuntime } from './runtime.js';

guardLogs();

const viaSns = (message: unknown) => JSON.stringify({ Type: 'Notification', Message: JSON.stringify(message) });
export const sqs = (...bodies: string[]): SQSEvent => ({ Records: bodies.map((body, i) => ({ eventSource: 'aws:sqs', messageId: `m${i}`, body }) as SQSEvent['Records'][number]) });

const AT = '2026-11-07T07:59:00.000Z';
const bounce = (bounceType: string, ...to: string[]) => viaSns({ eventType: 'Bounce', bounce: { bounceType, bounceSubType: 'General', timestamp: AT, bouncedRecipients: to.map((emailAddress) => ({ emailAddress })) }, mail: { destination: to } });
const complaint = (...to: string[]) => viaSns({ notificationType: 'Complaint', complaint: { complaintFeedbackType: 'abuse', timestamp: AT, complainedRecipients: to.map((emailAddress) => ({ emailAddress })) } });

/** A runtime whose recordDeliveryProblem answers `answer` and records each call. */
function fakeRecord(answer: (email: unknown) => Promise<Result<{ flagged: boolean }>>) {
	const t = testAuth();
	const calls: unknown[][] = [];
	const auth: AuthRuntime = {
		...t.auth,
		kit: {
			...t.auth.kit,
			recordDeliveryProblem: async (email: unknown, kind: unknown, at?: unknown) => {
				calls.push([email, kind, at]);
				return answer(email);
			}
		}
	};
	return { auth, calls };
}

describe('handleMailEvents', () => {
	it('flags a listed user on a permanent bounce, at the event’s time, shown by listUsers', async () => {
		const t = testAuth();
		t.clock.advance(-2 * 60 * 60_000); // added at 06:00, before the event at 07:59
		const admin = await bootstrap(t);
		const r = await handleMailEvents(sqs(bounce('Permanent', ADMIN)), t.auth);
		expect(r).toEqual({ batchItemFailures: [] });
		const listed = await t.auth.kit.listUsers({ ...admin });
		expect(listed.ok && listed.value[0]!.undeliverable).toEqual({ kind: 'bounce', at: AT });
		expect(eventsLogged()).toEqual([{ event: 'mail.bounce', bounceType: 'Permanent', bounceSubType: 'General', recipients: 1, flagged: 1, unchanged: 0, refused: 0, retry: false }]);
	});

	it('flags a complaint as `complaint`, and leaves an unlisted recipient and a redelivery unchanged', async () => {
		const t = testAuth();
		t.clock.advance(-2 * 60 * 60_000);
		const admin = await bootstrap(t);
		expect(await handleMailEvents(sqs(complaint(ADMIN, 'nobody@example.test')), t.auth)).toEqual({ batchItemFailures: [] });
		expect(await handleMailEvents(sqs(complaint(ADMIN)), t.auth)).toEqual({ batchItemFailures: [] });
		const listed = await t.auth.kit.listUsers(admin);
		expect(listed.ok && listed.value[0]!.undeliverable).toEqual({ kind: 'complaint', at: AT });
		expect(eventsLogged()).toEqual([
			{ event: 'mail.complaint', feedbackType: 'abuse', recipients: 2, flagged: 1, unchanged: 1, refused: 0, retry: false },
			{ event: 'mail.complaint', feedbackType: 'abuse', recipients: 1, flagged: 0, unchanged: 1, refused: 0, retry: false }
		]);
	});

	it('only logs a transient bounce, never flagging anyone', async () => {
		const { auth, calls } = fakeRecord(async () => ({ ok: true, value: { flagged: true } }));
		expect(await handleMailEvents(sqs(bounce('Transient', ADMIN)), auth)).toEqual({ batchItemFailures: [] });
		expect(calls).toEqual([]);
		expect(eventsLogged()).toEqual([{ event: 'mail.bounce', bounceType: 'Transient', bounceSubType: 'General', recipients: 1 }]);
	});

	it('passes each recipient with the kind and SES’s time (falling back to the mail’s)', async () => {
		const { auth, calls } = fakeRecord(async () => ({ ok: true, value: { flagged: false } }));
		await handleMailEvents(sqs(bounce('Permanent', 'a@example.test', 'b@example.test'), viaSns({ eventType: 'Complaint', mail: { timestamp: AT }, complaint: { complainedRecipients: [{ emailAddress: 'c@example.test' }] } })), auth);
		expect(calls).toEqual([
			['a@example.test', 'bounce', AT],
			['b@example.test', 'bounce', AT],
			['c@example.test', 'complaint', AT]
		]);
	});

	it('reports a record whose recording got a 409 in batchItemFailures, so SQS redelivers it, and only that record', async () => {
		const { auth } = fakeRecord(async (email) => (email === 'busy@example.test' ? { ok: false, status: 409, error: 'changed meanwhile' } : { ok: true, value: { flagged: true } }));
		const r = await handleMailEvents(sqs(bounce('Permanent', 'a@example.test'), complaint('b@example.test', 'busy@example.test')), auth);
		expect(r).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
		expect(eventsLogged()[1]).toEqual({ event: 'mail.complaint', feedbackType: 'abuse', recipients: 2, flagged: 1, unchanged: 0, refused: 0, retry: true });
	});

	it('redelivers on a store error, logging its name and code only (never the message, which may hold the address)', async () => {
		const { auth } = fakeRecord(async (email) => {
			throw Object.assign(new Error(`Transaction cancelled for ${String(email)}`), { name: 'TransactionCanceledException' });
		});
		expect(await handleMailEvents(sqs(bounce('Permanent', 'gone@example.test')), auth)).toEqual({ batchItemFailures: [{ itemIdentifier: 'm0' }] });
		expect(eventsLogged()[0]).toEqual({ event: 'mail.record_failed', error: 'TransactionCanceledException' });
	});

	it('drops what retrying can’t fix: a 400 from auth-kit, an unreadable record, another event type', async () => {
		const { auth } = fakeRecord(async () => ({ ok: false, status: 400, error: 'Enter a whole email address' }));
		const r = await handleMailEvents(sqs(bounce('Permanent', 'not an address'), 'not json', viaSns({ eventType: 'Delivery' })), auth);
		expect(r).toEqual({ batchItemFailures: [] });
		expect(eventsLogged()).toEqual([
			{ event: 'mail.bounce', bounceType: 'Permanent', bounceSubType: 'General', recipients: 1, flagged: 0, unchanged: 0, refused: 1, retry: false },
			{ event: 'mail.event_ignored', kind: 'unreadable' },
			{ event: 'mail.event_ignored', kind: 'Delivery' }
		]);
	});

	it('redelivers every bounce and complaint while sign-in is unconfigured, and says so once', async () => {
		const r = await handleMailEvents(sqs(bounce('Permanent', 'a@example.test'), complaint('b@example.test'), bounce('Transient', 'c@example.test')), { ready: false, problem: 'AUTH_CODE_KEY is missing' });
		expect(r).toEqual({ batchItemFailures: [{ itemIdentifier: 'm0' }, { itemIdentifier: 'm1' }] });
		expect(eventsLogged().at(-1)).toEqual({ event: 'mail.events_unrecorded', reason: 'sign-in is not configured', records: 2 });
	});

	it('tells an SQS batch from a Function URL request', () => {
		expect(isSqsEvent(sqs('{}'))).toBe(true);
		expect(isSqsEvent({ Records: [{ eventSource: 'aws:s3' }] })).toBe(false);
		expect(isSqsEvent({ Records: [] })).toBe(false);
		expect(isSqsEvent({ rawPath: '/health', requestContext: {} })).toBe(false);
		expect(isSqsEvent(null)).toBe(false);
	});
});
