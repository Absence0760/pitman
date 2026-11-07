// The sign-in email and its transports: the text, the console transport's masked line, and the SES
// request (with the configuration set). The SMTP transport is dev-only (server.ts) and kept out of the
// Lambda bundle (lambda.test.ts).
import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { describe, expect, it, vi } from 'vitest';
import { guardLogs, linesLogged } from '../__tests__/logGuard.js';
import { consoleMailer, createMailer, maskAddress, SES_CLIENT_OPTIONS, SES_DEADLINE_ERROR, SES_SEND_WORST_CASE_MS, sesClient, sesMailer, signInMessage } from './mail.js';

guardLogs();

describe('the sign-in email', () => {
	it('is plain, short and carries only the code', () => {
		expect(signInMessage('012345')).toEqual({
			subject: 'Your Pitman sign-in code',
			text: "Your Pitman sign-in code is 012345. It expires in 10 minutes. If you didn't ask for it, ignore this email.\n"
		});
	});

	it('is printed by the console transport with the address masked', async () => {
		await consoleMailer()({ to: 'admin@example.test', code: '012345' });
		expect(linesLogged()).toEqual(['[mail:console] Pitman sign-in code 012345 for a…@example.test (not sent; MAIL_TRANSPORT=console)']);
		expect(maskAddress('x')).toBe('…');
	});

	it('is sent through SES v2 from the configured sender, with the configuration set', async () => {
		const sent: SendEmailCommand[] = [];
		const client = { send: async (c: SendEmailCommand) => void sent.push(c) } as never;
		await sesMailer({ from: 'Pitman <no-reply@example.test>', configurationSet: 'pitman', client })({ to: 'admin@example.test', code: '012345' });
		expect(sent.map((c) => c.input)).toEqual([
			{
				FromEmailAddress: 'Pitman <no-reply@example.test>',
				Destination: { ToAddresses: ['admin@example.test'] },
				ConfigurationSetName: 'pitman',
				Content: { Simple: { Subject: { Data: 'Your Pitman sign-in code', Charset: 'UTF-8' }, Body: { Text: { Data: signInMessage('012345').text, Charset: 'UTF-8' } } } }
			}
		]);
	});

	it('bounds the SES client: 2 attempts, 0.5 s to connect and 1 s a request that throws when exceeded, 4 s at worst', async () => {
		expect(SES_CLIENT_OPTIONS).toEqual({ maxAttempts: 2, requestHandler: { connectionTimeout: 500, requestTimeout: 1_000, throwOnRequestTimeout: true } });
		// Two whole attempts plus the longest throttling backoff before the second.
		expect(SES_SEND_WORST_CASE_MS).toBe(2 * (500 + 1_000) + 1_000);
		const client = sesClient();
		expect(await client.config.maxAttempts()).toBe(2);
		client.destroy();
	});

	it('stops a send that outlives the worst case: aborts it and throws, by name, with no address', async () => {
		vi.useFakeTimers();
		try {
			let signal: AbortSignal | undefined;
			// A send that never answers (a Retry-After stretching the SDK's backoff, say).
			const client = { send: (_c: SendEmailCommand, o: { abortSignal: AbortSignal }) => ((signal = o.abortSignal), new Promise(() => undefined)) } as never;
			const sending = sesMailer({ from: 'x', configurationSet: 'pitman', client })({ to: 'admin@example.test', code: '012345' });
			const outcome = sending.then(
				() => 'sent',
				(e: Error) => e
			);
			await vi.advanceTimersByTimeAsync(SES_SEND_WORST_CASE_MS - 1);
			expect(signal!.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			const e = await outcome;
			expect(e).toBeInstanceOf(Error);
			expect((e as Error).name).toBe(SES_DEADLINE_ERROR);
			expect((e as Error).message).not.toContain('@');
			expect(signal!.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('clears its deadline once a send answers, and passes a send failure through', async () => {
		vi.useFakeTimers();
		try {
			const ok = { send: async () => undefined } as never;
			await sesMailer({ from: 'x', configurationSet: 'pitman', client: ok })({ to: 'admin@example.test', code: '012345' });
			expect(vi.getTimerCount()).toBe(0);
			const failing = { send: async () => Promise.reject(Object.assign(new Error('rejected'), { name: 'MessageRejected' })) } as never;
			await expect(sesMailer({ from: 'x', configurationSet: 'pitman', client: failing })({ to: 'admin@example.test', code: '012345' })).rejects.toMatchObject({ name: 'MessageRejected' });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('picks the transport from the configuration', () => {
		expect(typeof createMailer({ kind: 'console', from: 'x' })).toBe('function');
		expect(typeof createMailer({ kind: 'ses', from: 'x', configurationSet: 'pitman' })).toBe('function');
		expect(createMailer({ kind: 'smtp', from: 'x', host: '127.0.0.1', port: 1025 })).toEqual({ problem: expect.stringContaining('local dev server') });
	});
});
