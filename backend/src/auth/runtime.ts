// Sign-in, assembled: auth-kit bound to its store and keys, the mail queue and mailer, and the cookie. createApp() takes
// one (tests build theirs with createAuthRuntime and a memory store); lambda.ts and server.ts build it from
// the environment. When the configuration has a gap the runtime is `{ ready: false }` and every route
// behind the gate answers 503.
import { createAuthKit, DEFAULT_MIN_LATENCY_MS, type AuthKit, type Clock, type Random, type Sleep, type Store } from '@absence0760/auth-kit';
import { readAuthConfig } from './config.js';
import { sessionCookieFor, type SessionCookie } from './cookies.js';
import { createMailer, type Mailer, type SmtpMailerFactory } from './mail.js';
import { inlineMailQueue, mailSealer, sqsMailQueue, type MailQueue, type MailSealer } from './mailQueue.js';
import { createUserStore } from './store.js';

/**
 * POST /auth/code's floor: auth-kit's DEFAULT_MIN_LATENCY_MS (1 s). The request sends no mail (issue #30,
 * A-AUTH-14): a listed and an unlisted address both make the same store calls and put one sealed message of
 * one size on the queue, so nothing Pitman adds takes longer for one than the other. What is left to hide
 * is auth-kit's own store work, which is what its 1 s default is for. (Until #30 the email was sent inside
 * the floor, which had to cover SES's 4 s worst case: 4.5 s.)
 */
export const CODE_REQUEST_MIN_LATENCY_MS = DEFAULT_MIN_LATENCY_MS;

export interface AuthReady {
	ready: true;
	kit: AuthKit;
	/** The request side: POST /auth/code enqueues one message, real or decoy (mailQueue.ts). */
	queue: MailQueue;
	/** The consumer side: opens a queued message (keyed from AUTH_CODE_KEY) and sends it with `mail`. */
	sealer: MailSealer;
	mail: Mailer;
	cookie: SessionCookie;
	/** POST /auth/code's floor (auth-kit's withMinimumLatency); tests pass a clock and sleep they control. */
	latency: { minMs: number; clock?: Clock; sleep?: Sleep };
}

export type AuthRuntime = AuthReady | { ready: false; problem: string };

/** The session key's id in the token header. A rotation by `terraform apply -replace` signs everyone out (A-AUTH-8). */
export const SESSION_KEY_ID = 'k1';

export interface AuthParts {
	store: Store;
	codeKey: string;
	sessionKey: string;
	mail: Mailer;
	/** The queue, given the sealer. Default: the in-process queue (local dev, tests). */
	queue?: (sealer: MailSealer) => MailQueue;
	devCookie?: boolean;
	clock?: Clock;
	random?: Random;
	sleep?: Sleep;
	minLatencyMs?: number;
}

export function createAuthRuntime(parts: AuthParts): AuthRuntime {
	let kit: AuthKit;
	try {
		kit = createAuthKit({
			store: parts.store,
			codeSecret: parts.codeKey,
			sessionKeys: [{ kid: SESSION_KEY_ID, secret: parts.sessionKey }],
			issuer: 'pitman',
			...(parts.clock ? { clock: parts.clock } : {}),
			...(parts.random ? { random: parts.random } : {})
		});
	} catch (e) {
		// auth-kit's key checks; its messages name the setting, never the value.
		return { ready: false, problem: e instanceof Error ? e.message : 'the sign-in keys are not usable' };
	}
	const sealer = mailSealer(parts.codeKey);
	return {
		ready: true,
		kit,
		queue: parts.queue ? parts.queue(sealer) : inlineMailQueue({ sealer, mail: parts.mail, clock: parts.clock ?? { now: () => Date.now() } }),
		sealer,
		mail: parts.mail,
		cookie: sessionCookieFor(parts.devCookie ?? false),
		latency: { minMs: parts.minLatencyMs ?? CODE_REQUEST_MIN_LATENCY_MS, ...(parts.clock ? { clock: parts.clock } : {}), ...(parts.sleep ? { sleep: parts.sleep } : {}) }
	};
}

/** From the environment. `smtp` is passed by the dev server only. Logs a gap once, by its description. */
export function authRuntimeFromEnv(env: Record<string, string | undefined>, options: { smtp?: SmtpMailerFactory } = {}): AuthRuntime {
	const config = readAuthConfig(env);
	const runtime = ((): AuthRuntime => {
		if (!config.ok) return { ready: false, problem: config.problem };
		const mail = createMailer(config.config.mail, options.smtp);
		if ('problem' in mail) return { ready: false, problem: mail.problem };
		const q = config.config.queue;
		const queue = q.kind === 'sqs' ? (sealer: MailSealer) => sqsMailQueue({ queueUrl: q.url, sealer }) : undefined;
		return createAuthRuntime({ store: createUserStore(config.config.store), codeKey: config.config.codeKey, sessionKey: config.config.sessionKey, mail, ...(queue ? { queue } : {}), devCookie: config.config.devCookie });
	})();
	if (!runtime.ready) console.error(JSON.stringify({ event: 'auth.unconfigured', problem: runtime.problem }));
	return runtime;
}
