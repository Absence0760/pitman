// The sign-in email: its text, and the transport MAIL_TRANSPORT picks (docs/run-locally.md § Sign-in):
//
//   console  local dev default. Prints the code with a masked address; sends nothing, needs nothing.
//   smtp     local dev with Mailpit (`pnpm dev:auth:up`, UI on http://localhost:8025). Built by the dev
//            entry (server.ts → mail.smtp.ts), so nodemailer never enters the Lambda bundle.
//   ses      the Lambda: SES v2 SendEmail through its own role, with the configuration set.
//
// A mailer throws on failure. Since issue #30 no request waits on one: /auth/code enqueues the email
// (mailQueue.ts) and whatever reads the queue sends it, logging a failure as `mail.send_failed`.
import { CODE_TTL_MS } from '@absence0760/auth-kit';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { AuthConfig } from './config.js';

export interface SignInMail {
	to: string;
	code: string;
}

export type Mailer = (mail: SignInMail) => Promise<void>;

/** Builds the SMTP mailer; only the dev entry passes one (see mail.smtp.ts). */
export type SmtpMailerFactory = (options: { host: string; port: number; from: string }) => Mailer;

const MINUTES = Math.round(CODE_TTL_MS / 60_000);

/** The email: plain text, short, and nothing in it but the code. */
export function signInMessage(code: string): { subject: string; text: string } {
	return {
		subject: 'Your Pitman sign-in code',
		text: `Your Pitman sign-in code is ${code}. It expires in ${MINUTES} minutes. If you didn't ask for it, ignore this email.\n`
	};
}

/** `a…@example.test`: enough to tell dev users apart, never a whole address in a log. */
export function maskAddress(address: string): string {
	const at = address.lastIndexOf('@');
	return at <= 0 ? '…' : `${address[0]}…${address.slice(at)}`;
}

export function consoleMailer(): Mailer {
	return async ({ to, code }) => {
		console.log(`[mail:console] Pitman sign-in code ${code} for ${maskAddress(to)} (not sent; MAIL_TRANSPORT=console)`);
	};
}

/**
 * The SES client's bounds. The send runs in the mail-queue worker (mailWorker.ts), which sends a batch's
 * records at once, so a batch lasts one send's worst case; the SDK's defaults (3 attempts with backoff, no
 * request timeout) would let a stalled SES hold the function to its timeout instead. Two attempts, each cut
 * off after 1 s (0.5 s to connect). `throwOnRequestTimeout` is what makes `requestTimeout` a bound at all:
 * without it @smithy/node-http-handler only logs a warning when a request runs past it. A failed send is
 * logged as `mail.send_failed` and SQS tries it again (A-AUTH-14).
 */
export const SES_CLIENT_OPTIONS = { maxAttempts: 2, requestHandler: { connectionTimeout: 500, requestTimeout: 1_000, throwOnRequestTimeout: true } } as const;

/**
 * The longest backoff @smithy's standard retry strategy waits before the second attempt: a random fraction
 * of its base delay × 2⁰ (capped at 20 s). The base is 100 ms for a transient error and 500 ms for
 * throttling (SES's TooManyRequests); `SMITHY_NEW_RETRIES_2026=true` doubles the throttling base to 1 s.
 * 1 s covers both. Read from @smithy/core 3.38.1 (submodules/retry, StandardRetryStrategy).
 */
export const SES_RETRY_BACKOFF_MAX_MS = 1_000;

/**
 * A send's worst case under SES_CLIENT_OPTIONS: every attempt spends its whole connect and request
 * timeouts (an over-estimate, since the request timer runs from the start of the attempt), plus the longest
 * backoff between attempts: 2 × (0.5 + 1) + 1 = 4 s. sesMailer also stops a send here, whatever the SDK does.
 */
export const SES_SEND_WORST_CASE_MS =
	SES_CLIENT_OPTIONS.maxAttempts * (SES_CLIENT_OPTIONS.requestHandler.connectionTimeout + SES_CLIENT_OPTIONS.requestHandler.requestTimeout) +
	(SES_CLIENT_OPTIONS.maxAttempts - 1) * SES_RETRY_BACKOFF_MAX_MS;

/** The error's name when sesMailer stops a send at SES_SEND_WORST_CASE_MS. */
export const SES_DEADLINE_ERROR = 'SesSendDeadlineExceeded';

/** The Lambda's SES client: its region and role (SES lives in the same region, A-AUTH-7), bounded as above. */
export const sesClient = () => new SESv2Client({ ...SES_CLIENT_OPTIONS, requestHandler: { ...SES_CLIENT_OPTIONS.requestHandler } });

export function sesMailer(options: { from: string; configurationSet: string; client?: Pick<SESv2Client, 'send'> }): Mailer {
	const client = options.client ?? sesClient();
	return async ({ to, code }) => {
		const message = signInMessage(code);
		const command = new SendEmailCommand({
			FromEmailAddress: options.from,
			Destination: { ToAddresses: [to] },
			ConfigurationSetName: options.configurationSet,
			Content: {
				Simple: {
					Subject: { Data: message.subject, Charset: 'UTF-8' },
					Body: { Text: { Data: message.text, Charset: 'UTF-8' } }
				}
			}
		});
		// A hard stop at the computed worst case. The options above bound each attempt, but a Retry-After
		// header on a throttling answer can stretch the SDK's backoff by up to 5 s more, so the options alone
		// don't bound a send. At the deadline the send is aborted and this throws (logged as mail.send_failed).
		const abort = new AbortController();
		const sending = client.send(command, { abortSignal: abort.signal });
		sending.catch(() => undefined); // the race's loser must not become an unhandled rejection
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const e = Object.assign(new Error('the SES send ran past its deadline'), { name: SES_DEADLINE_ERROR });
				abort.abort(e);
				reject(e);
			}, SES_SEND_WORST_CASE_MS);
		});
		try {
			await Promise.race([sending, deadline]);
		} finally {
			clearTimeout(timer);
		}
	};
}

/** The configured mailer, or why there is none. */
export function createMailer(config: AuthConfig['mail'], smtp?: SmtpMailerFactory): Mailer | { problem: string } {
	switch (config.kind) {
		case 'console':
			return consoleMailer();
		case 'smtp':
			// Only server.ts supplies the SMTP factory; anywhere else, smtp is a configuration gap.
			return smtp ? smtp(config) : { problem: 'MAIL_TRANSPORT=smtp is available only from the local dev server' };
		case 'ses':
			return sesMailer(config);
	}
}
