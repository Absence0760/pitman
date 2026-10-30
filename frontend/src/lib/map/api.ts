/**
 * The clients for `GET ${PUBLIC_API_URL}/quaternaries` and
 * `POST ${PUBLIC_API_URL}/map-grid/cells` (`packages/wrsm/src/subdivide/contract.ts`).
 * Errors come back as `MapRequestError` with a kind the panel acts on and a
 * message it shows as it is. Only the box goes up (issue #3 rule 7).
 */

import type { MapGridCells, MapGridCellsRequest, QuaternaryCollection } from '@pitman/wrsm';
import { apiUrl } from '#lib/extend/api.js';

export const QUATERNARIES_PATH = '/quaternaries';
export const MAP_GRID_CELLS_PATH = '/map-grid/cells';

/** How long to wait for the backend, ms. A cold start may read a whole grid file. */
export const MAP_TIMEOUT_MS = 30_000;

/** `unavailable` is the 503: nothing configured or not there yet. `too_wide`, `too_dense`, `no_coverage` are the grid's refusals. */
export type MapErrorKind = 'unavailable' | 'too_wide' | 'too_dense' | 'no_coverage' | 'refused' | 'busy' | 'server' | 'network' | 'timeout' | 'invalid';

export class MapRequestError extends Error {
	constructor(
		readonly kind: MapErrorKind,
		message: string,
		readonly status?: number
	) {
		super(message);
		this.name = 'MapRequestError';
	}
}

export interface MapClientOptions {
	/** The API base (`PUBLIC_API_URL`). */
	readonly baseUrl: string | undefined;
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Check a `GET /quaternaries` answer: the map and the wizard rely on every field. */
export function readQuaternaries(body: unknown): QuaternaryCollection {
	const bad = (what: string): never => {
		throw new MapRequestError('invalid', `The boundary service sent an answer Pitman can’t read (${what}).`);
	};
	if (typeof body !== 'object' || body === null) return bad('not an object');
	const b = body as Record<string, unknown>;
	if (!Array.isArray(b['features'])) return bad('no features');
	if (!isText(b['source'])) return bad('no source');
	for (const f of b['features'] as unknown[]) {
		const feature = f as { properties?: { code?: unknown }; geometry?: { type?: unknown; coordinates?: unknown } } | null;
		if (!isText(feature?.properties?.code)) return bad('a feature without its code');
		if ((feature?.geometry?.type !== 'Polygon' && feature?.geometry?.type !== 'MultiPolygon') || !Array.isArray(feature.geometry.coordinates)) return bad('a feature without its outline');
	}
	return body as QuaternaryCollection;
}

/** Check a `POST /map-grid/cells` answer. */
export function readMapGridCells(body: unknown): MapGridCells {
	const bad = (what: string): never => {
		throw new MapRequestError('invalid', `The MAP grid service sent an answer Pitman can’t read (${what}).`);
	};
	if (typeof body !== 'object' || body === null) return bad('not an object');
	const b = body as Record<string, unknown>;
	if (!isText(b['dataset']) || !isText(b['source'])) return bad('no dataset or source');
	for (const key of ['cellDeg', 'originLon', 'originLat', 'cols', 'rows'] as const) if (!isNumber(b[key])) bad(`no ${key}`);
	if (!((b['cellDeg'] as number) > 0)) bad('no cell size');
	if (!Array.isArray(b['values']) || b['values'].length !== (b['rows'] as number) * (b['cols'] as number)) return bad('values don’t fill the block');
	return body as MapGridCells;
}

/** The answer's `{ error, code }`, when it is JSON. */
async function refusal(response: Response): Promise<{ message: string | undefined; code: string | undefined }> {
	try {
		const body = (await response.json()) as { error?: unknown; code?: unknown } | null;
		return { message: isText(body?.error) ? body.error.trim() : undefined, code: isText(body?.code) ? body.code : undefined };
	} catch {
		return { message: undefined, code: undefined };
	}
}

const REFUSAL_KINDS: Readonly<Record<string, MapErrorKind>> = { too_wide: 'too_wide', too_dense: 'too_dense', no_coverage: 'no_coverage' };

async function request(service: string, url: string, init: RequestInit, options: MapClientOptions): Promise<unknown> {
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const timeoutMs = options.timeoutMs ?? MAP_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (options.signal?.aborted) controller.abort();
	options.signal?.addEventListener('abort', onAbort, { once: true });
	const late = () => new MapRequestError('timeout', `The ${service} did not answer within ${Math.round(timeoutMs / 1000)} seconds. Try again.`);
	try {
		let response: Response;
		try {
			response = await doFetch(url, { ...init, signal: controller.signal });
		} catch (error) {
			if (timedOut) throw late();
			if (options.signal?.aborted) throw error;
			throw new MapRequestError('network', `Pitman could not reach the ${service}. Check the connection and try again.`);
		}
		if (!response.ok) {
			const { message, code } = await refusal(response);
			if (response.status === 429) throw new MapRequestError('busy', `The ${service} is busy (too many requests). Wait a minute and try again.`, 429);
			if (response.status === 503) throw new MapRequestError('unavailable', message ?? `The ${service} is not available.`, 503);
			if (response.status >= 400 && response.status < 500) {
				throw new MapRequestError((code && REFUSAL_KINDS[code]) || 'refused', message ?? `The ${service} refused the request (HTTP ${response.status}).`, response.status);
			}
			throw new MapRequestError('server', `The ${service} failed (HTTP ${response.status})${message ? `: ${message}` : ''}. Try again later.`, response.status);
		}
		try {
			return await response.json();
		} catch (error) {
			if (timedOut) throw late();
			if (options.signal?.aborted) throw error;
			throw new MapRequestError('invalid', `The ${service} sent an answer Pitman can’t read (not JSON).`);
		}
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', onAbort);
	}
}

/** The quaternary boundaries. Rejects with `MapRequestError` (`unavailable` when none are configured), or an `AbortError` when `signal` aborts. */
export async function fetchQuaternaries(options: MapClientOptions): Promise<QuaternaryCollection> {
	const body = await request('boundary service', apiUrl(options.baseUrl, QUATERNARIES_PATH), { headers: { accept: 'application/json' } }, options);
	return readQuaternaries(body);
}

/** The finest grid's values over a box. Rejects like `fetchQuaternaries`. */
export async function fetchMapGridCells(bbox: MapGridCellsRequest['bbox'], options: MapClientOptions): Promise<MapGridCells> {
	const payload: MapGridCellsRequest = { bbox };
	const body = await request(
		'MAP grid service',
		apiUrl(options.baseUrl, MAP_GRID_CELLS_PATH),
		{ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload) },
		options
	);
	return readMapGridCells(body);
}
