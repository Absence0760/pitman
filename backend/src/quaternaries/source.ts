// Where the API's quaternary boundaries come from (local-first, CLAUDE.md). `QUATERNARIES_SOURCE=local`
// (the committed backend/.env.development's value) reads a GeoJSON file from disk
// (QUATERNARIES_LOCAL_FILE), the synthetic region Z in dev; unset or empty is "not configured", a 503.
// Production stays unset: no licensed boundaries exist for Pitman yet (docs/data.md § Quaternaries, D-1).
// QUATERNARIES_CREDIT is the line the screen and the sidecar credit them with (rule 8).
//
// A file is read once per instance and kept. The answer is the whole file trimmed to the wire type, so
// a file too big for one Lambda answer is refused here, in words, not by a 500 from the function URL.
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { AreaGeometry, QuaternaryCollection, QuaternaryFeature } from '@pitman/wrsm';
import { CopyUnavailableError } from '../chirps/copy.js';

/** The largest answer (bytes of JSON): Lambda's synchronous response limit is 6 MB. */
export const MAX_QUATERNARY_ANSWER_BYTES = 5 * 1024 * 1024;
const CODE = /^[A-Z][0-9]{2}[A-Z]$/;

type Env = Record<string, string | undefined>;

export interface QuaternarySource {
	file: string;
	credit: string;
}

/** The boundaries the environment names, or what is wrong with the setting. */
export function quaternarySourceFromEnv(env: Env = process.env): QuaternarySource | { problem: string } {
	const source = (env.QUATERNARIES_SOURCE ?? '').trim();
	if (!source) return { problem: 'QUATERNARIES_SOURCE is not set: Pitman has no licensed quaternary boundaries yet (D-1)' };
	if (source !== 'local') return { problem: `QUATERNARIES_SOURCE must be local, not ${source.slice(0, 80)}` };
	const file = env.QUATERNARIES_LOCAL_FILE?.trim();
	if (!file) return { problem: 'QUATERNARIES_LOCAL_FILE is not set' };
	return { file: resolve(file), credit: env.QUATERNARIES_CREDIT?.trim() || basename(file) };
}

const positiveOrAbsent = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** A GeoJSON file → the wire type, or why it can't be read. Only the code, area and MAP go out: anything else in the file stays on the server. */
export function parseQuaternaries(doc: unknown, credit: string): QuaternaryCollection | string {
	const features = (doc as { features?: unknown } | null)?.features;
	if (!Array.isArray(features) || features.length === 0) return 'it holds no features';
	const out: QuaternaryFeature[] = [];
	for (const [i, f] of features.entries()) {
		const p = (f as { properties?: Record<string, unknown> } | null)?.properties ?? {};
		const g = (f as { geometry?: { type?: unknown; coordinates?: unknown } } | null)?.geometry;
		const code = p['code'];
		if (typeof code !== 'string' || !CODE.test(code)) return `feature ${i + 1} has no quaternary code`;
		if ((g?.type !== 'Polygon' && g?.type !== 'MultiPolygon') || !Array.isArray(g.coordinates)) return `${code} is not a Polygon or MultiPolygon`;
		const mapMm = positiveOrAbsent(p['mapMm']);
		const areaKm2 = positiveOrAbsent(p['areaKm2']);
		out.push({
			type: 'Feature',
			properties: { code, ...(mapMm === undefined ? {} : { mapMm }), ...(areaKm2 === undefined ? {} : { areaKm2 }) },
			geometry: g as AreaGeometry
		});
	}
	return { type: 'FeatureCollection', features: out, source: credit };
}

/** The configured boundaries, read once; a failed read isn't kept, so the next request retries. */
export class QuaternaryStore {
	readonly source: QuaternarySource | { problem: string };
	#body: string | undefined;

	constructor(source: QuaternarySource | { problem: string }) {
		this.source = source;
	}

	/** The answer's JSON. Throws CopyUnavailableError (a 503) saying what is missing. */
	body(): string {
		if (this.#body !== undefined) return this.#body;
		const s = this.source;
		if ('problem' in s) throw new CopyUnavailableError(`quaternary boundaries are not configured: ${s.problem}`);
		if (!existsSync(s.file)) throw new CopyUnavailableError(`there is no quaternary boundary file at ${s.file}; set QUATERNARIES_LOCAL_FILE`);
		let doc: unknown;
		try {
			doc = JSON.parse(readFileSync(s.file, 'utf8'));
		} catch {
			throw new CopyUnavailableError(`the quaternary boundary file ${s.file} is not JSON`);
		}
		const parsed = parseQuaternaries(doc, s.credit);
		if (typeof parsed === 'string') throw new CopyUnavailableError(`the quaternary boundary file can't be read: ${parsed}`);
		const body = JSON.stringify(parsed);
		if (body.length > MAX_QUATERNARY_ANSWER_BYTES) {
			throw new CopyUnavailableError(`the quaternary boundary file is larger than one answer carries (${MAX_QUATERNARY_ANSWER_BYTES / 1024 / 1024} MiB): simplify it or clip it to the study area`);
		}
		this.#body = body;
		return body;
	}
}
