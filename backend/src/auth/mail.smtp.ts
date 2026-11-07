// The SMTP transport, for local dev with Mailpit only. Imported by server.ts (the dev entry) and never
// from anything lambda.ts reaches, so nodemailer stays a dev dependency and out of the Lambda bundle
// (lambda.test.ts checks).
import { createTransport } from 'nodemailer';
import { signInMessage, type SmtpMailerFactory } from './mail.js';

export const smtpMailer: SmtpMailerFactory = ({ host, port, from }) => {
	// Mailpit: plain SMTP on loopback, no auth, no TLS.
	const transporter = createTransport({ host, port, secure: false, ignoreTLS: true });
	return async ({ to, code }) => {
		const message = signInMessage(code);
		// An address object, never a string nodemailer would parse (a string can hold a group or a list).
		await transporter.sendMail({ from, to: { name: '', address: to }, subject: message.subject, text: message.text });
	};
};
