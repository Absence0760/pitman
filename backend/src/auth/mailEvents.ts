// SES bounce and complaint notifications, delivered SES configuration set → SNS → SQS → this Lambda
// (A-AUTH-7). The queue accepts only that topic and the topic only SES, so this is the trusted source
// auth-kit's recordDeliveryProblem asks for; no route the public can reach calls it.
//
// Per record: a permanent bounce flags each bounced recipient (`bounce`), a complaint each complained
// recipient (`complaint`), at the time SES saw it, so the Users page shows it until an admin clears it.
// A transient bounce is only logged. auth-kit orders events by time, so a redelivered or late record is
// safe to pass in again; a 409 (contention, nothing decided) or a store error fails the record, and SQS
// redelivers it (the DLQ takes it after 5 tries). A record that can't be read, or an address or time
// auth-kit refuses (400), would fail the same way every time, so it is logged and dropped.
//
// Each record is logged as one line, `mail.bounce` or `mail.complaint`, with the event's type and counts:
// never an address (A-AUTH-11).
import type { Result } from '@absence0760/auth-kit';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { errorSummary } from '../http/logError.js';
import type { AuthRuntime } from './runtime.js';

const logEvent = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));

/** auth-kit's recordDeliveryProblem, or why there is none. */
export type RecordDeliveryProblem = (email: unknown, kind: 'bounce' | 'complaint', at?: unknown) => Promise<Result<{ flagged: boolean }>>;

/** True for an SQS batch (as opposed to a Function URL request). */
export function isSqsEvent(event: unknown): event is SQSEvent {
	if (!event || typeof event !== 'object' || !('Records' in event) || !Array.isArray(event.Records)) return false;
	const first: unknown = event.Records[0];
	return !!first && typeof first === 'object' && 'eventSource' in first && first.eventSource === 'aws:sqs';
}

type Recipient = { emailAddress?: unknown };
type SesEvent = {
	eventType?: string;
	notificationType?: string;
	mail?: { timestamp?: unknown };
	bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: Recipient[]; timestamp?: unknown };
	complaint?: { complaintFeedbackType?: string; complainedRecipients?: Recipient[]; timestamp?: unknown };
};

/** The SES event inside an SNS envelope inside an SQS body, or null. */
function sesEvent(body: string): SesEvent | null {
	try {
		const outer: unknown = JSON.parse(body);
		const message = outer && typeof outer === 'object' && 'Message' in outer && typeof outer.Message === 'string' ? outer.Message : body;
		const inner: unknown = JSON.parse(message);
		return inner && typeof inner === 'object' ? (inner as SesEvent) : null;
	} catch {
		return null;
	}
}

const list = (v: unknown): Recipient[] => (Array.isArray(v) ? v.filter((r): r is Recipient => !!r && typeof r === 'object') : []);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** How one record's recipients were recorded: counts only, and whether SQS must redeliver it. */
async function recordAll(record: RecordDeliveryProblem | null, recipients: Recipient[], kind: 'bounce' | 'complaint', at: unknown) {
	const tally = { flagged: 0, unchanged: 0, refused: 0, retry: false };
	if (!record) return { ...tally, retry: true };
	for (const r of recipients) {
		let result: Result<{ flagged: boolean }>;
		try {
			result = await record(r.emailAddress, kind, at);
		} catch (e) {
			// A store error decided nothing: redeliver. By name and code only, never the message.
			logEvent({ event: 'mail.record_failed', ...errorSummary(e) });
			tally.retry = true;
			continue;
		}
		if (result.ok) tally[result.value.flagged ? 'flagged' : 'unchanged']++;
		else if (result.status === 409) tally.retry = true;
		else tally.refused++;
	}
	return tally;
}

/** The handler. `auth` is the Lambda's sign-in runtime; unconfigured, every bounce and complaint is redelivered. */
export async function handleMailEvents(event: SQSEvent, auth: AuthRuntime): Promise<SQSBatchResponse> {
	const record: RecordDeliveryProblem | null = auth.ready ? (email, kind, at) => auth.kit.recordDeliveryProblem(email, kind, at) : null;
	const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
	for (const r of event.Records) {
		const e = sesEvent(r.body);
		// A configuration-set event names its kind in eventType; an identity notification in notificationType.
		const kind = e?.eventType ?? e?.notificationType;
		let retry = false;
		if (kind === 'Bounce') {
			const bounceType = str(e?.bounce?.bounceType);
			const recipients = list(e?.bounce?.bouncedRecipients);
			// A transient bounce (mailbox full, a timeout) may deliver next time: logged, never flagged.
			const tally = bounceType === 'Permanent' ? await recordAll(record, recipients, 'bounce', e?.bounce?.timestamp ?? e?.mail?.timestamp) : null;
			retry = !!tally?.retry;
			logEvent({ event: 'mail.bounce', bounceType, bounceSubType: str(e?.bounce?.bounceSubType), recipients: recipients.length, ...(tally ? { flagged: tally.flagged, unchanged: tally.unchanged, refused: tally.refused, retry } : {}) });
		} else if (kind === 'Complaint') {
			const recipients = list(e?.complaint?.complainedRecipients);
			const tally = await recordAll(record, recipients, 'complaint', e?.complaint?.timestamp ?? e?.mail?.timestamp);
			retry = tally.retry;
			logEvent({ event: 'mail.complaint', feedbackType: str(e?.complaint?.complaintFeedbackType), recipients: recipients.length, flagged: tally.flagged, unchanged: tally.unchanged, refused: tally.refused, retry });
		} else {
			// Retrying a record we can't read would fail the same way; it is logged and dropped.
			logEvent({ event: 'mail.event_ignored', kind: typeof kind === 'string' ? kind : 'unreadable' });
		}
		if (retry) batchItemFailures.push({ itemIdentifier: r.messageId });
	}
	if (!auth.ready && batchItemFailures.length) logEvent({ event: 'mail.events_unrecorded', reason: 'sign-in is not configured', records: batchItemFailures.length });
	return { batchItemFailures };
}
