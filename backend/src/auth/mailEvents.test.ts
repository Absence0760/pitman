// SES bounce and complaint notifications (SQS of SNS of SES): one log line each, without the address.
import type { SQSEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { eventsLogged, guardLogs } from '../__tests__/logGuard.js';
import { handleMailEvents, isSqsEvent } from './mailEvents.js';

guardLogs();

const viaSns = (message: unknown) => JSON.stringify({ Type: 'Notification', Message: JSON.stringify(message) });
export const sqs = (...bodies: string[]): SQSEvent => ({ Records: bodies.map((body, i) => ({ eventSource: 'aws:sqs', messageId: `m${i}`, body }) as SQSEvent['Records'][number]) });

describe('handleMailEvents', () => {
	it('logs a bounce and a complaint by type and count, never by address, and fails nothing', async () => {
		const r = await handleMailEvents(
			sqs(
				viaSns({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'gone@example.test' }] }, mail: { destination: ['gone@example.test'] } }),
				viaSns({ notificationType: 'Complaint', complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'cross@example.test' }] } }),
				'not json',
				viaSns({ eventType: 'Delivery' })
			)
		);
		expect(r).toEqual({ batchItemFailures: [] });
		expect(eventsLogged()).toEqual([
			{ event: 'mail.bounce', bounceType: 'Permanent', bounceSubType: 'General', recipients: 1 },
			{ event: 'mail.complaint', feedbackType: 'abuse', recipients: 1 },
			{ event: 'mail.event_ignored', kind: 'unreadable' },
			{ event: 'mail.event_ignored', kind: 'Delivery' }
		]);
	});

	it('tells an SQS batch from a Function URL request', () => {
		expect(isSqsEvent(sqs('{}'))).toBe(true);
		expect(isSqsEvent({ Records: [{ eventSource: 'aws:s3' }] })).toBe(false);
		expect(isSqsEvent({ Records: [] })).toBe(false);
		expect(isSqsEvent({ rawPath: '/health', requestContext: {} })).toBe(false);
		expect(isSqsEvent(null)).toBe(false);
	});
});
