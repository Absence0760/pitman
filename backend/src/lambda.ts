// The Lambda entry. Three kinds of event reach it: Function URL requests from CloudFront (the Hono app),
// SQS batches from the sign-in mail queue (auth/mailWorker.ts, told apart by the queue in MAIL_QUEUE_URL),
// and SQS batches of SES bounce and complaint notifications (auth/mailEvents.ts). All share one sign-in
// runtime, built from the environment once per instance.
//
// The dispatch reads MAIL_QUEUE_URL itself rather than through the sign-in configuration, so a mail-queue
// batch reaches the mail worker (which redelivers it) even when sign-in is unconfigured, and is never
// handed to the bounce handler (which would drop it as unreadable).
import type { Context, SQSEvent } from 'aws-lambda';
import { handle, type LambdaEvent } from 'hono/aws-lambda';
import { createApp } from './app.js';
import { handleMailEvents, isSqsEvent } from './auth/mailEvents.js';
import { fromQueue } from './auth/mailQueue.js';
import { handleMailQueue } from './auth/mailWorker.js';
import { authRuntimeFromEnv } from './auth/runtime.js';

const auth = authRuntimeFromEnv(process.env);
const http = handle(createApp({ auth }));
const mailQueueUrl = process.env.MAIL_QUEUE_URL;

function sqs(event: SQSEvent) {
	return fromQueue(event.Records[0], mailQueueUrl) ? handleMailQueue(event, auth) : handleMailEvents(event, auth);
}

export const handler = (event: LambdaEvent | SQSEvent, context: Context) => (isSqsEvent(event) ? sqs(event) : http(event as LambdaEvent, context));
