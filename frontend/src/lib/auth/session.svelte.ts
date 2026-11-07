/**
 * Who is signed in, for the screens (runes). The session itself is an
 * HttpOnly cookie the browser holds; this only remembers what
 * `GET /api/auth/me` and `POST /api/auth/verify` said, so the app bar can
 * show the address and the gate can send a signed-out user to sign-in.
 * It is a convenience, not a boundary: the API checks every request.
 */

import * as api from './api.js';
import type { AuthClientOptions, User } from './api.js';

/**
 * unknown: not asked yet; checking: asking; in / out: the answer;
 * error: the API couldn't say (unreachable, 5xx), so nobody is sent anywhere.
 */
export type SessionStatus = 'unknown' | 'checking' | 'in' | 'out' | 'error';

export class Session {
	status = $state<SessionStatus>('unknown');
	user = $state.raw<User | null>(null);
	#options: AuthClientOptions;
	#pending: Promise<User | null> | undefined;

	constructor(options: AuthClientOptions) {
		this.#options = options;
	}

	get isAdmin(): boolean {
		return this.user?.isAdmin === true;
	}

	/** Ask the API who is signed in. Calls made while one is in flight share it. */
	me(): Promise<User | null> {
		if (this.#pending) return this.#pending;
		this.status = 'checking';
		this.#pending = api
			.fetchMe(this.#options)
			.then((user) => {
				this.#set(user);
				return user;
			})
			.catch((error: unknown) => {
				this.status = 'error';
				throw error;
			})
			.finally(() => {
				this.#pending = undefined;
			});
		return this.#pending;
	}

	requestCode(email: string): Promise<void> {
		return api.requestCode(email, this.#options);
	}

	async verify(email: string, code: string): Promise<User> {
		const user = await api.verifyCode(email, code, this.#options);
		this.#set(user);
		return user;
	}

	/** Sign out this browser. Forgotten here even if the API can't be reached, since the user asked to leave. */
	async logout(): Promise<void> {
		try {
			await api.logout(this.#options);
		} finally {
			this.#set(null);
		}
	}

	/** Sign out every browser this user is signed in on. */
	async logoutEverywhere(): Promise<void> {
		await api.logoutEverywhere(this.#options);
		this.#set(null);
	}

	/** The API refused the session (a 401 from a data call). */
	signedOut(): void {
		this.#set(null);
	}

	#set(user: User | null) {
		this.user = user;
		this.status = user ? 'in' : 'out';
	}
}
