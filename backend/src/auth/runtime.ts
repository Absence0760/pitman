// Sign-in, assembled: auth-kit bound to its store and keys, the mailer and the cookie. createApp() takes
// one (tests build theirs with createAuthRuntime and a memory store); lambda.ts and server.ts build it from
// the environment. When the configuration has a gap the runtime is `{ ready: false }` and every route
// behind the gate answers 503.
import { createAuthKit, DEFAULT_MIN_LATENCY_MS, type AuthKit, type Clock, type Random, type Sleep, type Store } from '@absence0760/auth-kit';
import { readAuthConfig } from './config.js';
import { sessionCookieFor, type SessionCookie } from './cookies.js';
import { createMailer, SES_SEND_WORST_CASE_MS, type Mailer, type SmtpMailerFactory } from './mail.js';
import { createUserStore } from './store.js';

/**
 * POST /auth/code's floor. auth-kit's DEFAULT_MIN_LATENCY_MS (1 s) covers its own store work, but Pitman
 * sends the email inside the floor too, and a slow SES send (SES_SEND_WORST_CASE_MS, 4 s) would carry a
 * listed address's answer past 1 s while an unlisted one's never is. So the floor is the SES worst case
 * rounded up to the next half second above it (4.5 s), leaving room for the store work; it moves with the
 * SES options, and runtime.test.ts fails if it ever falls below them.
 */
export const CODE_REQUEST_MIN_LATENCY_MS = Math.max(DEFAULT_MIN_LATENCY_MS, (Math.floor(SES_SEND_WORST_CASE_MS / 500) + 1) * 500);

export interface AuthReady {
	ready: true;
	kit: AuthKit;
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
	return {
		ready: true,
		kit,
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
		return createAuthRuntime({ store: createUserStore(config.config.store), codeKey: config.config.codeKey, sessionKey: config.config.sessionKey, mail, devCookie: config.config.devCookie });
	})();
	if (!runtime.ready) console.error(JSON.stringify({ event: 'auth.unconfigured', problem: runtime.problem }));
	return runtime;
}
