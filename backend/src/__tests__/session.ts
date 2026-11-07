// Sign-in for tests: auth-kit's memory store, throwaway keys, a clock the test moves and a sleep that moves
// it (never a real wait), and an outbox instead of mail. Synthetic addresses only (example.test).
//
// The mail queue records every sealed body POST /auth/code enqueues (`queued`, decoys included), then opens
// and delivers it at once through the real deliverSealed, so `outbox` holds the codes straight after a
// request. A slow or failing queue moves the test clock or throws, as SQS would.
import { cryptoRandom, memoryStore, randomSecret, type MemoryStore, type UserRecord } from '@absence0760/auth-kit';
import { createAuthRuntime, type AuthReady } from '../auth/runtime.js';
import type { SignInMail } from '../auth/mail.js';
import { deliverSealed } from '../auth/mailQueue.js';

export const TEST_ORIGIN = 'http://localhost:7777';
export const ADMIN = 'admin@example.test';

export interface TestClock {
	now(): number;
	advance(ms: number): void;
}

export interface TestAuth {
	auth: AuthReady;
	store: MemoryStore;
	outbox: SignInMail[];
	/** Every sealed message enqueued, in order: one per accepted code request, listed or not. */
	queued: string[];
	clock: TestClock;
	/** Every pad withMinimumLatency asked for, in ms. */
	sleeps: number[];
}

export function testClock(start = Date.parse('2026-11-07T08:00:00Z')): TestClock {
	let t = start;
	return { now: () => t, advance: (ms) => void (t += ms) };
}

export function testAuth(options: { devCookie?: boolean; mailFails?: boolean; queueFails?: boolean; queueDelayMs?: number; store?: MemoryStore; minLatencyMs?: number } = {}): TestAuth {
	const store = options.store ?? memoryStore();
	const outbox: SignInMail[] = [];
	const queued: string[] = [];
	const clock = testClock();
	const sleeps: number[] = [];
	const mail = async (m: SignInMail) => {
		if (options.mailFails) throw Object.assign(new Error(`could not deliver to ${m.to}`), { name: 'MessageRejected' });
		outbox.push(m);
	};
	const auth = createAuthRuntime({
		store,
		codeKey: randomSecret(cryptoRandom),
		sessionKey: randomSecret(cryptoRandom),
		mail,
		queue: (sealer) => ({
			async enqueue(m) {
				// A slow SendMessage: moves the test clock, never a real wait.
				if (options.queueDelayMs) clock.advance(options.queueDelayMs);
				if (options.queueFails) throw Object.assign(new Error(`could not enqueue for ${m?.to ?? 'nobody'}`), { name: 'QueueDoesNotExist' });
				const body = sealer.seal(m);
				queued.push(body);
				await deliverSealed(body, { sealer, mail, clock });
			}
		}),
		devCookie: options.devCookie ?? false,
		clock,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.advance(ms);
		},
		...(options.minLatencyMs !== undefined ? { minLatencyMs: options.minLatencyMs } : {})
	});
	if (!auth.ready) throw new Error(auth.problem);
	return { auth, store, outbox, queued, clock, sleeps };
}

/** Bootstraps ADMIN (once) and returns them. */
export async function bootstrap(t: TestAuth, email = ADMIN): Promise<UserRecord> {
	const r = await t.auth.kit.bootstrapAdmin(email);
	if (!r.ok) throw new Error(r.error);
	return r.value;
}

/** A Cookie request header carrying a fresh session for `user`. */
export async function cookieFor(t: TestAuth, user: UserRecord): Promise<string> {
	const { token } = await t.auth.kit.issueSession(user);
	return `${t.auth.cookie.name}=${token}`;
}

export type Requester = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

/** The app, with every request sent as a signed-in browser on the allowed origin would send it. */
export function asSignedIn(app: Requester, cookie: string): Requester {
	return {
		request: (path, init = {}) => {
			const headers = new Headers(init.headers);
			if (!headers.has('cookie')) headers.set('cookie', cookie);
			// A browser on the site sends its Origin with every POST (http/sameOrigin.ts).
			if (!headers.has('origin')) headers.set('origin', TEST_ORIGIN);
			return app.request(path, { ...init, headers });
		}
	};
}

/** One signed-in admin, for tests of the data routes behind the gate. */
export async function signedIn(): Promise<{ auth: AuthReady; cookie: string }> {
	const t = testAuth();
	return { auth: t.auth, cookie: await cookieFor(t, await bootstrap(t)) };
}
