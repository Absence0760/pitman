/**
 * The client for `POST ${PUBLIC_API_URL}/delineate` and `GET /channels` (agent 5.2; subdivide.md
 * § Hydrological split): a tributary from a click, and the terrain channels to click on. Only the click and
 * the piece's outline are sent, never the network's files. Errors come back as `TributaryRequestError`
 * with a message the screen shows as it is; a refusal keeps its `reason`.
 */

import type { AreaGeometry, ChannelCollection, DelineateRefusal, DelineateResponse, DemProvenance } from '@pitman/wrsm';
import { apiUrl } from '#lib/extend/api.js';
import { sessionFetch } from '#lib/auth/unauthorized.js';

export const DELINEATE_PATH = '/delineate';
export const CHANNELS_PATH = '/channels';

/** How long to wait for one delineation, ms: over the backend's 30 s limit, so its own answer gets through. */
export const DELINEATE_TIMEOUT_MS = 40_000;
export const CHANNELS_TIMEOUT_MS = 40_000;
/** The backend's largest channel box (degrees): boxes are cut to this grid, so each is a whole number of its tiles. */
export const CHANNEL_BOX_DEG = 0.4;
/** A box past its deadline answers 504 and keeps its work, so it is asked for again this many times. */
export const CHANNEL_RETRIES = 2;

/** The contract's response and the backend's two additions (decision R5-D4). */
export interface DelineateAnswer extends DelineateResponse {
	readonly dem: DemProvenance & { readonly attribution: string };
	/** What drains into closed pans inside the catchment, km²; reported only. */
	readonly pansKm2: number;
}

/** With `larger_channel`: the channel the click probably meant. */
export interface LargerChannel {
	readonly at: readonly [number, number];
	readonly distanceM: number;
	readonly km2: number;
	readonly pointKm2: number;
}

export type TributaryErrorKind = 'refused' | 'busy' | 'server' | 'network' | 'timeout' | 'invalid';

export class TributaryRequestError extends Error {
	constructor(
		readonly kind: TributaryErrorKind,
		message: string,
		readonly status?: number,
		readonly reason?: DelineateRefusal,
		readonly larger?: LargerChannel
	) {
		super(message);
		this.name = 'TributaryRequestError';
	}
}

export interface TributaryClientOptions {
	/** The API base (`PUBLIC_API_URL`). */
	readonly baseUrl: string | undefined;
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

const NAME = 'the elevation service';
const NAME_UP = 'The elevation service';

const REASONS: readonly DelineateRefusal[] = ['outside', 'no_data', 'off_channel', 'too_small', 'too_large', 'larger_channel', 'whole_quaternary'];

function refusalOf(body: unknown): { error?: string; reason?: DelineateRefusal; larger?: LargerChannel } {
	if (typeof body !== 'object' || body === null) return {};
	const b = body as { error?: unknown; reason?: unknown; larger?: unknown };
	const error = typeof b.error === 'string' && b.error.trim() !== '' ? b.error.trim() : undefined;
	const reason = REASONS.find((r) => r === b.reason);
	const larger = b.larger as LargerChannel | undefined;
	const usable = larger !== undefined && Array.isArray(larger.at) && larger.at.length === 2 && typeof larger.km2 === 'number';
	return { ...(error ? { error } : {}), ...(reason ? { reason } : {}), ...(usable ? { larger } : {}) };
}

/** One request with a timeout, a caller's abort and the screen's messages. */
async function request(url: string, init: RequestInit, options: TributaryClientOptions, timeoutMs: number): Promise<unknown> {
	// A 401 sends the user to sign-in (lib/auth/unauthorized.ts); the error below still reaches the screen.
	const doFetch = sessionFetch(options.fetch);
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (options.signal?.aborted) controller.abort();
	options.signal?.addEventListener('abort', onAbort, { once: true });
	const late = () => new TributaryRequestError('timeout', `${NAME_UP} did not answer within ${Math.round(timeoutMs / 1000)} seconds. Try again.`);
	try {
		let response: Response;
		try {
			response = await doFetch(url, { ...init, signal: controller.signal });
		} catch (error) {
			if (timedOut) throw late();
			if (options.signal?.aborted) throw error;
			throw new TributaryRequestError('network', `Pitman could not reach ${NAME}. Check the connection and try again.`);
		}
		if (!response.ok) {
			const refusal = refusalOf(await response.json().catch(() => undefined));
			if (response.status === 429) throw new TributaryRequestError('busy', `${NAME_UP} is busy (too many requests). Wait a few minutes and try again.`, 429);
			if (response.status >= 400 && response.status < 500) {
				throw new TributaryRequestError('refused', refusal.error ?? `${NAME_UP} refused the request (HTTP ${response.status}).`, response.status, refusal.reason, refusal.larger);
			}
			throw new TributaryRequestError('server', `${NAME_UP} failed (HTTP ${response.status})${refusal.error ? `: ${refusal.error}` : ''}.`, response.status);
		}
		try {
			return await response.json();
		} catch (error) {
			if (timedOut) throw late();
			if (options.signal?.aborted) throw error;
			throw new TributaryRequestError('invalid', `${NAME_UP} sent an answer Pitman can’t read (not JSON).`);
		}
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', onAbort);
	}
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isArea = (v: unknown) => {
	const g = v as { type?: unknown; coordinates?: unknown } | null;
	return typeof g === 'object' && g !== null && (g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates);
};

/** Check the answer's shape: the map and the sidecar rely on every field. */
export function readDelineateAnswer(body: unknown): DelineateAnswer {
	const bad = (what: string): never => {
		throw new TributaryRequestError('invalid', `${NAME_UP} sent an answer Pitman can’t read (${what}).`);
	};
	if (typeof body !== 'object' || body === null) return bad('not an object');
	const b = body as Record<string, unknown>;
	for (const key of ['tributary', 'remainder'] as const) if (!isArea(b[key])) bad(`no ${key}`);
	for (const key of ['tributaryKm2', 'remainderKm2', 'outsideKm2', 'outsidePct', 'snapM', 'pansKm2'] as const) if (!isNumber(b[key])) bad(`no ${key}`);
	if (b['warning'] !== null && typeof b['warning'] !== 'string') bad('no warning');
	const dem = b['dem'] as Record<string, unknown> | null | undefined;
	if (typeof dem !== 'object' || dem === null || typeof dem['label'] !== 'string' || typeof dem['fingerprint'] !== 'string' || !isNumber(dem['zoom'])) bad('no dem');
	return body as DelineateAnswer;
}

export function readChannels(body: unknown): ChannelCollection {
	const b = body as { type?: unknown; features?: unknown } | null;
	if (typeof b !== 'object' || b === null || b.type !== 'FeatureCollection' || !Array.isArray(b.features)) {
		throw new TributaryRequestError('invalid', `${NAME_UP} sent an answer Pitman can’t read (no channels).`);
	}
	return body as ChannelCollection;
}

/** Delineate the tributary at a click. `keepPoint` answers a `larger_channel` refusal: the small channel was meant. */
export async function fetchDelineation(
	point: readonly [number, number],
	within: AreaGeometry,
	options: TributaryClientOptions & { readonly keepPoint?: boolean }
): Promise<DelineateAnswer> {
	const body = { point, within, ...(options.keepPoint ? { keepPoint: true } : {}) };
	const json = await request(
		apiUrl(options.baseUrl, DELINEATE_PATH),
		{ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) },
		options,
		options.timeoutMs ?? DELINEATE_TIMEOUT_MS
	);
	return readDelineateAnswer(json);
}

/** `[west, south, east, north]` of a geometry. */
export function bboxOf(g: AreaGeometry): [number, number, number, number] {
	const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
	const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
	for (const polygon of polygons) {
		for (const ring of polygon) {
			for (const [lon, lat] of ring) {
				box[0] = Math.min(box[0], lon);
				box[1] = Math.min(box[1], lat);
				box[2] = Math.max(box[2], lon);
				box[3] = Math.max(box[3], lat);
			}
		}
	}
	return box;
}

/** The fixed grid's boxes a box touches: at most the backend's size, none sharing a tile, so no line comes twice. */
export function channelBoxes([w, s, e, n]: readonly [number, number, number, number]): [number, number, number, number][] {
	const d = CHANNEL_BOX_DEG;
	const at = (k: number) => Math.round(k * d * 1000) / 1000;
	const out: [number, number, number, number][] = [];
	for (let j = Math.floor(s / d); j * d < n; j++) {
		for (let i = Math.floor(w / d); i * d < e; i++) out.push([at(i), at(j), at(i + 1), at(j + 1)]);
	}
	return out;
}

/** One box of terrain channels; a box past the backend's deadline is asked for again, its work kept. */
export async function fetchChannels(bbox: readonly [number, number, number, number], options: TributaryClientOptions): Promise<ChannelCollection> {
	const url = `${apiUrl(options.baseUrl, CHANNELS_PATH)}?bbox=${bbox.join(',')}`;
	for (let attempt = 0; ; attempt++) {
		try {
			return readChannels(await request(url, { headers: { accept: 'application/json' } }, options, options.timeoutMs ?? CHANNELS_TIMEOUT_MS));
		} catch (error) {
			if (!(error instanceof TributaryRequestError && error.status === 504 && attempt < CHANNEL_RETRIES)) throw error;
		}
	}
}

/** The channels over a geometry, box by box in order; `onpart` gets all that has arrived so far after each box. */
/** A box already fetched, for a tool that opens again on the same piece. */
export type ChannelBoxCache = Map<string, ChannelCollection>;

/** The most boxes one area may ask for: a quaternary needs four at most, and each box routes up to nine tiles. */
export const MAX_CHANNEL_BOXES = 9;

export async function fetchChannelsOver(within: AreaGeometry, options: TributaryClientOptions, onpart: (so_far: ChannelCollection) => void, cache?: ChannelBoxCache): Promise<ChannelCollection> {
	const boxes = channelBoxes(bboxOf(within));
	if (boxes.length > MAX_CHANNEL_BOXES) {
		throw new TributaryRequestError('refused', 'This area is too large to draw its terrain channels. Sub-divide a single quaternary, or split by a MAP zone.', 422);
	}
	const features: ChannelCollection['features'][number][] = [];
	for (const box of boxes) {
		const key = box.join(',');
		const part = cache?.get(key) ?? (await fetchChannels(box, options));
		cache?.set(key, part);
		features.push(...part.features);
		onpart({ type: 'FeatureCollection', features: [...features] });
	}
	return { type: 'FeatureCollection', features };
}
