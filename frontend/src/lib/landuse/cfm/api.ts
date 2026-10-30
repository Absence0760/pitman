/**
 * The client for `POST ${PUBLIC_API_URL}/cfm/land-use` (docs/data.md § Cape
 * Farm Mapper): an area's crop fields and dams. The request is the geometry
 * and nothing else (issue #3 rule 7), and no token ever reaches this side
 * (D3). Errors come back as `LandUseRequestError` with a kind the panel acts
 * on and a message it shows as it is.
 */

import type { AreaGeometry, LandUseAnswer, LandUseRequest, QuaternaryCollection } from '@pitman/wrsm';
import { apiUrl } from '#lib/extend/api.js';
import { API_BASE_URL } from '#lib/extend/api-base.js';
import { fetchQuaternaries } from '#lib/map/api.js';

export const LAND_USE_PATH = '/cfm/land-use';

/** How long to wait for the backend, ms: past its own 25 s read limit, so its answer arrives first. */
export const LAND_USE_TIMEOUT_MS = 40_000;

/** `unavailable` is the 503: nothing configured, or Cape Farm Mapper not answering. */
export type LandUseErrorKind = 'unavailable' | 'refused' | 'busy' | 'server' | 'network' | 'timeout' | 'invalid';

export class LandUseRequestError extends Error {
	constructor(
		readonly kind: LandUseErrorKind,
		message: string,
		readonly status?: number
	) {
		super(message);
		this.name = 'LandUseRequestError';
	}
}

export interface LandUseClientOptions {
	/** The API base (`PUBLIC_API_URL`). */
	readonly baseUrl: string | undefined;
	readonly fetch?: typeof fetch;
	/** Cancels the request. */
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Check the answer's shape: the screen and the engine rely on every field. */
export function readLandUse(body: unknown): LandUseAnswer {
	const bad = (what: string): never => {
		throw new LandUseRequestError('invalid', `The land-use service sent an answer Pitman can’t read (${what}).`);
	};
	if (!isObject(body)) return bad('not an object');
	if (!Array.isArray(body['fields'])) return bad('no fields');
	for (const f of body['fields'] as unknown[]) {
		if (!isObject(f) || !isText(f['id']) || !isText(f['crop'])) return bad('a field without its crop');
		if (!(f['irrigated'] === null || typeof f['irrigated'] === 'boolean')) return bad('a field’s irrigation is not yes, no or unknown');
		if (!isNumber(f['areaHa']) || f['areaHa'] < 0) return bad('a field without its area');
		const g = f['geometry'];
		if (!isObject(g) || (g['type'] !== 'Polygon' && g['type'] !== 'MultiPolygon') || !Array.isArray(g['coordinates'])) return bad('a field without its shape');
	}
	if (!Array.isArray(body['dams'])) return bad('no dams');
	for (const d of body['dams'] as unknown[]) {
		if (!isObject(d) || !isText(d['id']) || !isNumber(d['lon']) || !isNumber(d['lat'])) return bad('a dam without its place');
		if (d['source'] !== 'register' && d['source'] !== 'capeFarmMapper' && d['source'] !== 'surfaceWater') return bad('a dam without its source');
		for (const key of ['capacityMm3', 'areaKm2']) if (d[key] !== undefined && !(isNumber(d[key]) && d[key] >= 0)) return bad('a dam’s figure is not a number');
	}
	if (!isText(body['dataset'])) return bad('no dataset');
	if (!Number.isInteger(body['surveyYear'])) return bad('no survey year');
	if (typeof body['fetchedOn'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body['fetchedOn'])) return bad('no fetch date');
	if (body['source'] !== 'cfm' && body['source'] !== 'local') return bad('no source');
	if (body['warnings'] !== undefined && !(Array.isArray(body['warnings']) && body['warnings'].every(isText))) return bad('warnings that are not text');
	return body as unknown as LandUseAnswer;
}

async function errorMessage(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as unknown;
		const text = isObject(body) && typeof body['error'] === 'string' ? body['error'].trim() : '';
		return text === '' ? undefined : text;
	} catch {
		return undefined;
	}
}

/** Fetch an area's fields and dams. Rejects with `LandUseRequestError`, or an `AbortError` when `signal` aborts. */
export async function fetchLandUse(area: AreaGeometry, options: LandUseClientOptions): Promise<LandUseAnswer> {
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const timeoutMs = options.timeoutMs ?? LAND_USE_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (options.signal?.aborted) controller.abort();
	options.signal?.addEventListener('abort', onAbort, { once: true });
	const lateMessage = `The land-use service did not answer within ${Math.round(timeoutMs / 1000)} seconds. Try again; a smaller area answers faster.`;
	const body: LandUseRequest = { area };
	try {
		let response: Response;
		try {
			response = await doFetch(apiUrl(options.baseUrl, LAND_USE_PATH), {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal
			});
		} catch (error) {
			if (timedOut) throw new LandUseRequestError('timeout', lateMessage);
			if (options.signal?.aborted) throw error;
			throw new LandUseRequestError('network', 'Pitman could not reach the land-use service. Check the connection and try again.');
		}
		if (!response.ok) {
			const message = await errorMessage(response);
			if (response.status === 429) throw new LandUseRequestError('busy', message ?? 'The land-use service is busy (too many requests). Wait a minute and try again.', 429);
			if (response.status === 503) throw new LandUseRequestError('unavailable', message ?? 'it is not available', 503);
			if (response.status === 504) throw new LandUseRequestError('timeout', message ?? lateMessage, 504);
			if (response.status >= 400 && response.status < 500) throw new LandUseRequestError('refused', message ?? `The land-use service refused the area (HTTP ${response.status}).`, response.status);
			throw new LandUseRequestError('server', `The land-use service failed (HTTP ${response.status})${message ? `: ${message}` : ''}. Try again later.`, response.status);
		}
		let json: unknown;
		try {
			json = await response.json();
		} catch (error) {
			if (timedOut) throw new LandUseRequestError('timeout', lateMessage);
			if (options.signal?.aborted) throw error;
			throw new LandUseRequestError('invalid', 'The land-use service sent an answer Pitman can’t read (not JSON).');
		}
		return readLandUse(json);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', onAbort);
	}
}

/** What the panel needs from the backend. Tests pass a fake. */
export interface LandUseClient {
	quaternaries(signal: AbortSignal): Promise<QuaternaryCollection>;
	landUse(area: AreaGeometry, signal: AbortSignal): Promise<LandUseAnswer>;
}

/** The real client, on the page's API base. */
export const landUseClient: LandUseClient = {
	quaternaries: (signal) => fetchQuaternaries({ baseUrl: API_BASE_URL, signal }),
	landUse: (area, signal) => fetchLandUse(area, { baseUrl: API_BASE_URL, signal })
};
