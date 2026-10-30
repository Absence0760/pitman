/**
 * The three questions the wizard asks the backend: the quaternaries, a box of
 * the MAP grid (the threshold tool) and a piece's mean MAP. Each sends a
 * geometry or a box, never a network file (issue #3 rule 7). Errors come back
 * as `SubdivideRequestError`, with a sentence the screen shows as it is.
 *
 * `POST /map-grid/mean` is Round 4's route (docs/data.md § MAP grids): under
 * 90 % coverage it answers 422 with the reason, which is how a piece the grid
 * doesn't cover reaches the screen. `GET /quaternaries` is not served until
 * decision D-1 is settled, so a 404 sends the user to the boundary upload.
 */

import type { AreaGeometry, MapGridCells, MapGridCellsRequest, MapGridSample, QuaternaryCollection } from '@pitman/wrsm';
import { apiUrl } from '#lib/extend/api.js';

export const QUATERNARIES_PATH = '/quaternaries';
export const MAP_GRID_CELLS_PATH = '/map-grid/cells';
export const MAP_GRID_MEAN_PATH = '/map-grid/mean';

/** How long to wait for the backend, ms. */
export const DATA_TIMEOUT_MS = 30_000;

/** The answer of `POST /map-grid/mean`: the sample plus the grid's provenance (rule 8). */
export interface MapGridMean extends MapGridSample {
	readonly cellDeg: number;
	/** Share of the area with a grid value, %. */
	readonly coveragePct: number;
	readonly version: string;
	readonly attribution: string;
	/** Which store answered (local-first). */
	readonly source: 'local' | 's3';
}

/** What the wizard needs from the backend. Tests pass a fake. */
export interface SubdivideData {
	quaternaries(signal: AbortSignal): Promise<QuaternaryCollection>;
	mapGridCells(bbox: MapGridCellsRequest['bbox'], signal: AbortSignal): Promise<MapGridCells>;
	mapGridMean(area: AreaGeometry, signal: AbortSignal): Promise<MapGridMean>;
}

export type DataErrorKind = 'refused' | 'busy' | 'server' | 'network' | 'timeout' | 'invalid';

export class SubdivideRequestError extends Error {
	constructor(
		readonly kind: DataErrorKind,
		message: string,
		readonly status?: number
	) {
		super(message);
		this.name = 'SubdivideRequestError';
	}
}

export interface SubdivideDataOptions {
	/** The API base (`PUBLIC_API_URL`). */
	readonly baseUrl: string | undefined;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
}

async function serviceMessage(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as { error?: unknown };
		return typeof body.error === 'string' && body.error.trim() !== '' ? body.error.trim() : undefined;
	} catch {
		return undefined; // Not JSON: the status says it.
	}
}

async function request(what: string, path: string, init: RequestInit, signal: AbortSignal, options: SubdivideDataOptions): Promise<unknown> {
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const timeoutMs = options.timeoutMs ?? DATA_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (signal.aborted) controller.abort();
	signal.addEventListener('abort', onAbort, { once: true });
	const failed = (error: unknown): unknown => {
		if (timedOut) return new SubdivideRequestError('timeout', `The ${what} service did not answer within ${Math.round(timeoutMs / 1000)} seconds. Try again.`);
		if (signal.aborted) return error; // The user cancelled: the caller ignores an AbortError.
		return new SubdivideRequestError('network', `Pitman could not reach the ${what} service. Check the connection and try again.`);
	};
	try {
		let response: Response;
		try {
			response = await doFetch(apiUrl(options.baseUrl, path), { ...init, signal: controller.signal });
		} catch (error) {
			throw failed(error);
		}
		if (!response.ok) {
			const message = await serviceMessage(response);
			if (response.status === 429) throw new SubdivideRequestError('busy', `The ${what} service is busy (too many requests). Wait a minute and try again.`, 429);
			if (response.status < 500) throw new SubdivideRequestError('refused', message ?? `The ${what} service refused the request (HTTP ${response.status}).`, response.status);
			throw new SubdivideRequestError('server', `The ${what} service failed (HTTP ${response.status})${message ? `: ${message}` : ''}. Try again later.`, response.status);
		}
		try {
			return await response.json();
		} catch (error) {
			if (timedOut || signal.aborted) throw failed(error);
			throw new SubdivideRequestError('invalid', `The ${what} service sent an answer Pitman can’t read (not JSON).`);
		}
	} finally {
		clearTimeout(timer);
		signal.removeEventListener('abort', onAbort);
	}
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

function invalid(what: string, detail: string): SubdivideRequestError {
	return new SubdivideRequestError('invalid', `The ${what} service sent an answer Pitman can’t read (${detail}).`);
}

/** Check the shape of `GET /quaternaries`. */
export function readQuaternaries(body: unknown): QuaternaryCollection {
	const b = body as Partial<QuaternaryCollection> | null;
	if (typeof b !== 'object' || b === null || b.type !== 'FeatureCollection' || !Array.isArray(b.features)) throw invalid('quaternary', 'not a FeatureCollection');
	for (const f of b.features) {
		if (!isText(f?.properties?.code)) throw invalid('quaternary', 'a feature without its code');
		if (f.geometry?.type !== 'Polygon' && f.geometry?.type !== 'MultiPolygon') throw invalid('quaternary', `${f.properties.code} has no polygon`);
	}
	if (!isText(b.source)) throw invalid('quaternary', 'no source');
	return b as QuaternaryCollection;
}

/** Check the shape of `POST /map-grid/cells`. */
export function readMapGridCells(body: unknown): MapGridCells {
	const b = body as Partial<MapGridCells> | null;
	if (typeof b !== 'object' || b === null) throw invalid('MAP grid', 'not an object');
	for (const key of ['cellDeg', 'originLon', 'originLat', 'cols', 'rows'] as const) if (!isNumber(b[key])) throw invalid('MAP grid', `no ${key}`);
	if (!isText(b.dataset) || !isText(b.source)) throw invalid('MAP grid', 'no dataset or source');
	if (!Array.isArray(b.values) || b.values.length !== (b.rows as number) * (b.cols as number)) throw invalid('MAP grid', 'the values do not fill rows × cols');
	return b as MapGridCells;
}

/** Check the shape of `POST /map-grid/mean`. */
export function readMapGridMean(body: unknown): MapGridMean {
	const b = body as Partial<MapGridMean> | null;
	if (typeof b !== 'object' || b === null) throw invalid('MAP grid', 'not an object');
	for (const key of ['cellSizeM', 'cellCount', 'meanMapMm', 'cellDeg', 'coveragePct'] as const) if (!isNumber(b[key])) throw invalid('MAP grid', `no ${key}`);
	if (!isText(b.grid)) throw invalid('MAP grid', 'no grid name');
	return b as MapGridMean;
}

const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' } };

export function createSubdivideData(options: SubdivideDataOptions): SubdivideData {
	return {
		quaternaries: async (signal) => {
			try {
				return readQuaternaries(await request('quaternary', QUATERNARIES_PATH, { headers: { accept: 'application/json' } }, signal, options));
			} catch (error) {
				if (error instanceof SubdivideRequestError && error.status === 404) {
					throw new SubdivideRequestError('refused', 'This Pitman serves no quaternary boundaries yet. Upload the boundary as a GeoJSON file instead.', 404);
				}
				throw error;
			}
		},
		mapGridCells: async (bbox, signal) => readMapGridCells(await request('MAP grid', MAP_GRID_CELLS_PATH, { ...JSON_POST, body: JSON.stringify({ bbox }) }, signal, options)),
		mapGridMean: async (area, signal) => readMapGridMean(await request('MAP grid', MAP_GRID_MEAN_PATH, { ...JSON_POST, body: JSON.stringify({ area }) }, signal, options))
	};
}
