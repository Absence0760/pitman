/**
 * The client for `POST ${PUBLIC_API_URL}/chirps/monthly` (agent 4.2; extend.md §§ Steps
 * 1–3): an area's monthly CHIRPS totals for the full record. The request
 * body is the geometry and nothing else (issue #3 rule 7). Errors come back
 * as `ChirpsRequestError` with a message the screen shows as it is.
 */

import type { AreaGeometry, ChirpsMonthly, ChirpsMonthlyRequest } from '@pitman/wrsm';
import { sessionFetch } from '#lib/auth/unauthorized.js';

/** The route, relative to the API base (decision R4-I4: the base carries any `/api` prefix). */
export const CHIRPS_MONTHLY_PATH = '/chirps/monthly';

/** How long to wait for the backend, ms. A 2 000-cell area over 45 years is the slow case. */
export const CHIRPS_TIMEOUT_MS = 60_000;

export type ChirpsErrorKind = 'refused' | 'busy' | 'server' | 'network' | 'timeout' | 'invalid';

export class ChirpsRequestError extends Error {
	constructor(
		readonly kind: ChirpsErrorKind,
		message: string,
		readonly status?: number
	) {
		super(message);
		this.name = 'ChirpsRequestError';
	}
}

/**
 * The URL of a route under the API base (decision R4-I4). `PUBLIC_API_URL`
 * is `/api` in dev and production alike: CloudFront (or Vite's proxy in dev)
 * serves the API on the site's own origin and strips `/api` (the CSP's
 * `connect-src` is `'self'`, so it must stay relative; A-AUTH-9).
 */
export function apiUrl(base: string | undefined, path: string): string {
	const b = (base ?? '').trim().replace(/\/+$/, '');
	return b + (path.startsWith('/') ? path : `/${path}`);
}

export interface ChirpsClientOptions {
	/** The API base (`PUBLIC_API_URL`). */
	readonly baseUrl: string | undefined;
	readonly fetch?: typeof fetch;
	/** Cancels the request (the screen's Cancel, or leaving the step). */
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

function isNumber(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

/** Check the answer's shape: the screen and the engine rely on every field. */
export function readChirpsMonthly(body: unknown): ChirpsMonthly {
	const bad = (what: string): never => {
		throw new ChirpsRequestError('invalid', `The rainfall service sent an answer Pitman can’t read (${what}).`);
	};
	if (typeof body !== 'object' || body === null) return bad('not an object');
	const b = body as Record<string, unknown>;
	if (!Array.isArray(b['months']) || b['months'].length === 0) return bad('no months');
	let previous: number | undefined;
	for (const m of b['months'] as unknown[]) {
		const month = m as Record<string, unknown>;
		if (typeof m !== 'object' || m === null || !Number.isInteger(month['year']) || !Number.isInteger(month['month'])) return bad('a month without its date');
		if (!(month['mm'] === null || (isNumber(month['mm']) && month['mm'] >= 0))) return bad('a monthly total that is not a number');
		const index = (month['year'] as number) * 12 + (month['month'] as number);
		if ((month['month'] as number) < 1 || (month['month'] as number) > 12 || (previous !== undefined && index !== previous + 1)) {
			return bad('months out of order or skipped');
		}
		previous = index;
	}
	for (const key of ['cells', 'weightRemovedPct', 'areaKm2', 'revision'] as const) if (!isNumber(b[key])) bad(`no ${key}`);
	if (typeof b['product'] !== 'string' || b['product'] === '') bad('no product');
	if (typeof b['finalThrough'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b['finalThrough'])) bad('no finalThrough date');
	if (b['source'] !== 's3' && b['source'] !== 'local') bad('no source');
	return body as ChirpsMonthly;
}

async function errorMessage(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as unknown;
		if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') {
			const text = ((body as { error: string }).error).trim();
			return text === '' ? undefined : text;
		}
	} catch {
		// Not JSON: fall back to the status.
	}
	return undefined;
}

/** Fetch an area's monthly CHIRPS series. Rejects with `ChirpsRequestError`, or an `AbortError` when `signal` aborts. */
export async function fetchChirpsMonthly(area: AreaGeometry, options: ChirpsClientOptions): Promise<ChirpsMonthly> {
	// A 401 sends the user to sign-in (lib/auth/unauthorized.ts); the error below still reaches the screen.
	const doFetch = sessionFetch(options.fetch);
	const timeoutMs = options.timeoutMs ?? CHIRPS_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (options.signal?.aborted) controller.abort();
	options.signal?.addEventListener('abort', onAbort, { once: true });
	const body: ChirpsMonthlyRequest = { area };
	try {
		let response: Response;
		try {
			response = await doFetch(apiUrl(options.baseUrl, CHIRPS_MONTHLY_PATH), {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal
			});
		} catch (error) {
			if (timedOut) throw new ChirpsRequestError('timeout', `The rainfall service did not answer within ${Math.round(timeoutMs / 1000)} seconds. Try again; a smaller area answers faster.`);
			if (options.signal?.aborted) throw error;
			throw new ChirpsRequestError('network', 'Pitman could not reach the rainfall service. Check the connection and try again.');
		}
		if (!response.ok) {
			const message = await errorMessage(response);
			if (response.status === 429) {
				throw new ChirpsRequestError('busy', 'The rainfall service is busy (too many requests). Wait a minute and try again.', 429);
			}
			if (response.status >= 400 && response.status < 500) {
				throw new ChirpsRequestError('refused', message ?? `The rainfall service refused the area (HTTP ${response.status}).`, response.status);
			}
			throw new ChirpsRequestError(
				'server',
				`The rainfall service failed (HTTP ${response.status})${message ? `: ${message}` : ''}. Try again later.`,
				response.status
			);
		}
		let json: unknown;
		try {
			json = await response.json();
		} catch (error) {
			if (timedOut) throw new ChirpsRequestError('timeout', `The rainfall service did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
			if (options.signal?.aborted) throw error;
			throw new ChirpsRequestError('invalid', 'The rainfall service sent an answer Pitman can’t read (not JSON).');
		}
		return readChirpsMonthly(json);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', onAbort);
	}
}
