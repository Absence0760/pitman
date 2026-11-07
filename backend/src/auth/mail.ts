// The sign-in email: its text, and the transport MAIL_TRANSPORT picks (docs/run-locally.md § Sign-in):
//
//   console  local dev default. Prints the code with a masked address; sends nothing, needs nothing.
//   smtp     local dev with Mailpit (`pnpm dev:auth:up`, UI on http://localhost:8025). Built by the dev
//            entry (server.ts → mail.smtp.ts), so nodemailer never enters the Lambda bundle.
//   ses      the Lambda: SES v2 SendEmail through its own role, with the configuration set.
//
// A mailer throws on failure; the /auth/code route logs the failure by name and still answers 202, so
// a mail outage can't tell a listed address from an unlisted one.
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

export function sesMailer(options: { from: string; configurationSet: string; client?: Pick<SESv2Client, 'send'> }): Mailer {
	// The Lambda's region and role (SES lives in the same region, A-AUTH-7).
	const client = options.client ?? new SESv2Client({});
	return async ({ to, code }) => {
		const message = signInMessage(code);
		await client.send(
			new SendEmailCommand({
				FromEmailAddress: options.from,
				Destination: { ToAddresses: [to] },
				ConfigurationSetName: options.configurationSet,
				Content: {
					Simple: {
						Subject: { Data: message.subject, Charset: 'UTF-8' },
						Body: { Text: { Data: message.text, Charset: 'UTF-8' } }
					}
				}
			})
		);
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
