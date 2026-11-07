// SES bounce and complaint notifications, delivered SES configuration set → SNS → SQS → this Lambda
// (A-AUTH-7). Each record is logged as one line, `mail.bounce` or `mail.complaint`, with the event's type
// and how many recipients it names: never an address. Flagging the user on the Users page needs auth-kit's
// recordDeliveryProblem, which arrives in its v0.2.0; that bump wires it here.
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';

const logEvent = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));

/** True for an SQS batch (as opposed to a Function URL request). */
export function isSqsEvent(event: unknown): event is SQSEvent {
	if (!event || typeof event !== 'object' || !('Records' in event) || !Array.isArray(event.Records)) return false;
	const first: unknown = event.Records[0];
	return !!first && typeof first === 'object' && 'eventSource' in first && first.eventSource === 'aws:sqs';
}

type SesEvent = {
	eventType?: string;
	notificationType?: string;
	bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: unknown[] };
	complaint?: { complaintFeedbackType?: string; complainedRecipients?: unknown[] };
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

const count = (list: unknown) => (Array.isArray(list) ? list.length : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export async function handleMailEvents(event: SQSEvent): Promise<SQSBatchResponse> {
	for (const record of event.Records) {
		const e = sesEvent(record.body);
		// A configuration-set event names its kind in eventType; an identity notification in notificationType.
		const kind = e?.eventType ?? e?.notificationType;
		if (kind === 'Bounce') {
			logEvent({ event: 'mail.bounce', bounceType: str(e?.bounce?.bounceType), bounceSubType: str(e?.bounce?.bounceSubType), recipients: count(e?.bounce?.bouncedRecipients) });
		} else if (kind === 'Complaint') {
			logEvent({ event: 'mail.complaint', feedbackType: str(e?.complaint?.complaintFeedbackType), recipients: count(e?.complaint?.complainedRecipients) });
		} else {
			// Retrying a record we can't read would fail the same way; it is logged and dropped.
			logEvent({ event: 'mail.event_ignored', kind: typeof kind === 'string' ? kind : 'unreadable' });
		}
	}
	return { batchItemFailures: [] };
}
