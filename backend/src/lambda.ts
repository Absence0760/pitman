// The Lambda entry. Two kinds of event reach it: Function URL requests from CloudFront (the Hono app),
// and SQS batches of SES bounce and complaint notifications (auth/mailEvents.ts). Both share one sign-in
// runtime, built from the environment once per instance.
import type { Context, SQSEvent } from 'aws-lambda';
import { handle, type LambdaEvent } from 'hono/aws-lambda';
import { createApp } from './app.js';
import { handleMailEvents, isSqsEvent } from './auth/mailEvents.js';
import { authRuntimeFromEnv } from './auth/runtime.js';

const auth = authRuntimeFromEnv(process.env);
const http = handle(createApp({ auth }));

export const handler = (event: LambdaEvent | SQSEvent, context: Context) => (isSqsEvent(event) ? handleMailEvents(event, auth) : http(event as LambdaEvent, context));
