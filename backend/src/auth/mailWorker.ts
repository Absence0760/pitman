// The sign-in mail queue's consumer (issue #30, A-AUTH-14): SQS `pitman-mail-send` → this Lambda, through
// its own event source mapping (infra/mail_queue.tf). lambda.ts tells this queue's batches from the
// bounce queue's by the record's source ARN (MAIL_QUEUE_URL).
//
// Each record is one sealed message (mailQueue.ts). The batch's records are sent at once, so a batch takes
// one SES worst case (SES_SEND_WORST_CASE_MS, 4 s), well inside the Lambda's timeout. Only a send the
// transport refused (`mail.send_failed`) is reported back for another try; SQS redelivers it after the
// visibility timeout and, after 3 receives, dead-letters it (the DLQ alarm). A decoy, an expired code and a
// message that can't be opened would come out the same every time: they are dropped, the last two logged.
//
// One `mail.queue` line per batch, with counts only. Never a body, an address or a code (A-AUTH-11).
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { deliverSealed, type DeliveryOutcome } from './mailQueue.js';
import type { AuthRuntime } from './runtime.js';

const logEvent = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));

export async function handleMailQueue(event: SQSEvent, auth: AuthRuntime): Promise<SQSBatchResponse> {
	if (!auth.ready) {
		// No key to open the messages and no mailer: redeliver every one (they die in the DLQ, or expire
		// with their codes, if the configuration isn't fixed). auth.unconfigured has alarmed already.
		logEvent({ event: 'mail.queue_unsent', reason: 'sign-in is not configured', records: event.Records.length });
		return { batchItemFailures: event.Records.map((r) => ({ itemIdentifier: r.messageId })) };
	}
	const deps = { sealer: auth.sealer, mail: auth.mail, clock: auth.latency.clock ?? { now: () => Date.now() } };
	const outcomes = await Promise.all(event.Records.map((r) => deliverSealed(r.body, deps)));
	const counts: Record<DeliveryOutcome, number> = { sent: 0, decoy: 0, expired: 0, unreadable: 0, failed: 0 };
	for (const o of outcomes) counts[o]++;
	logEvent({ event: 'mail.queue', records: event.Records.length, ...counts });
	return { batchItemFailures: event.Records.flatMap((r, i) => (outcomes[i] === 'failed' ? [{ itemIdentifier: r.messageId }] : [])) };
}
