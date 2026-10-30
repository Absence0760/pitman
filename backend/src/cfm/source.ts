// Where POST /cfm/land-use reads from (local-first, CLAUDE.md), the pattern of mapgrid/source.ts. `CFM_SOURCE=local`
// (the committed backend/.env.development's value) answers from the invented fields and dams in code; `CFM_SOURCE=cfm`
// reads the real layers through arcgis.ts with the operator's CFM_TOKEN (D3), which only the Lambda's environment
// holds: CFM_CROPS_LAYER_URL is required, CFM_DAMS_LAYER_URL optional until question 3 says a dams layer exists.
// Unset or empty is "not configured" (a 503), which production is until the token arrives (issue #22 step 6).
import type { AreaGeometry, DamCandidate } from '@pitman/wrsm';
import { CopyUnavailableError } from '../chirps/copy.js';
import { syntheticDams } from '../dams/synthetic.js';
import { CFM_DATASET, CFM_SURVEY_YEAR, CROP_LAYER, CROP_OUT_FIELDS, DAM_LAYER, DAM_OUT_FIELDS, damFromFeature, fieldFromFeature, type LayerField } from './adapter.js';
import { queryLayer } from './arcgis.js';
import { SYNTHETIC_LAND_USE, syntheticFields } from './synthetic.js';

type Env = Record<string, string | undefined>;

export interface LayerRead {
	fields: LayerField[];
	dams: DamCandidate[];
	/** What the reader couldn't do, for the screen. */
	warnings: string[];
}

/** A land-use source: the raw layers near an area, before clipping. */
export interface LandUseSource {
	kind: 'cfm' | 'local';
	dataset: string;
	surveyYear: number;
	read(area: AreaGeometry, limits: { deadline: number; now: () => number }): Promise<LayerRead>;
}

function boxOf(area: AreaGeometry): [number, number, number, number] {
	const points = (area.type === 'Polygon' ? area.coordinates : area.coordinates.flat()).flat();
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The invented census and dams. */
export function localLandUseSource(): LandUseSource {
	return {
		kind: 'local',
		dataset: SYNTHETIC_LAND_USE.dataset,
		surveyYear: SYNTHETIC_LAND_USE.surveyYear,
		read: async (area) => {
			const box = boxOf(area);
			return { fields: syntheticFields(box), dams: syntheticDams(box), warnings: [] };
		}
	};
}

/** The real layers. `fetchFn` is injected in tests. */
export function cfmLandUseSource(opts: { cropsUrl: string; damsUrl?: string; token: string; fetchFn?: typeof fetch }): LandUseSource {
	const doFetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
	return {
		kind: 'cfm',
		dataset: CFM_DATASET,
		surveyYear: CFM_SURVEY_YEAR,
		read: async (area, { deadline, now }) => {
			const common = { token: opts.token, area, deadline, now, fetch: doFetch };
			const crops = await queryLayer({ ...common, layerUrl: opts.cropsUrl, outFields: CROP_OUT_FIELDS, orderBy: CROP_LAYER.id });
			const dams = opts.damsUrl ? await queryLayer({ ...common, layerUrl: opts.damsUrl, outFields: DAM_OUT_FIELDS, orderBy: DAM_LAYER.id }) : [];
			const fields = crops.map(fieldFromFeature);
			const candidates = dams.map(damFromFeature);
			const unread = fields.filter((f) => f === null).length;
			const unreadDams = candidates.filter((d) => d === null).length;
			return {
				fields: [...new Map(fields.flatMap((f) => (f ? [[f.id, f] as const] : []))).values()],
				dams: candidates.filter((d) => d !== null),
				warnings: [
					...(unread > 0 ? [`${unread} of the layer’s records could not be read and are left out of the areas.`] : []),
					...(unreadDams > 0 ? [`${unreadDams} of the dams layer’s records could not be read and are left out.`] : []),
					...(opts.damsUrl ? [] : ['No Cape Farm Mapper dams layer is configured, so no dams are listed.'])
				]
			};
		}
	};
}

const httpsUrl = (v: string) => /^https:\/\/[^/\s]+\/\S+$/.test(v);

/** The source the environment names, or what is wrong with the setting. The problem names variables, never a value. */
export function landUseSourceFromEnv(env: Env = process.env, opts: { fetchFn?: typeof fetch } = {}): LandUseSource | { problem: string } {
	const source = (env.CFM_SOURCE ?? '').trim();
	if (!source) return { problem: 'CFM_SOURCE is not set: Cape Farm Mapper needs the operator’s token (decision D3)' };
	if (source === 'local') return localLandUseSource();
	if (source !== 'cfm') return { problem: `CFM_SOURCE must be local or cfm, not ${source.slice(0, 80)}` };
	const token = env.CFM_TOKEN?.trim();
	const cropsUrl = env.CFM_CROPS_LAYER_URL?.trim();
	const damsUrl = env.CFM_DAMS_LAYER_URL?.trim() || undefined;
	if (!token) return { problem: 'CFM_TOKEN is not set' };
	if (!cropsUrl) return { problem: 'CFM_CROPS_LAYER_URL is not set' };
	// The token only ever crosses TLS.
	if (!httpsUrl(cropsUrl) || (damsUrl !== undefined && !httpsUrl(damsUrl))) return { problem: 'the CFM layer URLs must be https' };
	return cfmLandUseSource({ cropsUrl, damsUrl, token, fetchFn: opts.fetchFn });
}

/** The configured source. Throws CopyUnavailableError (a 503) saying what is missing. */
export function openLandUse(source: LandUseSource | { problem: string }): LandUseSource {
	if ('problem' in source) throw new CopyUnavailableError(`land-use data is not configured: ${source.problem}`);
	return source;
}
