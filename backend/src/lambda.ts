// The Lambda entry. Two kinds of event reach it: Function URL requests from CloudFront (the Hono app),
// and SQS batches of SES bounce and complaint notifications (auth/mailEvents.ts).
import type { Context, SQSEvent } from 'aws-lambda';
import { handle, type LambdaEvent } from 'hono/aws-lambda';
import { createApp } from './app.js';
import { handleMailEvents, isSqsEvent } from './auth/mailEvents.js';

const http = handle(createApp());

export const handler = (event: LambdaEvent | SQSEvent, context: Context) => (isSqsEvent(event) ? handleMailEvents(event) : http(event as LambdaEvent, context));
