// Where the API's DEM comes from (local-first, CLAUDE.md), the pattern of mapgrid/source.ts.
// `DEM_SOURCE=local` (the committed backend/.env.development's value) reads the archive
// `pnpm dev:data:synthetic` writes (DEM_LOCAL_FILE); `DEM_SOURCE=s3://bucket/key` reads the production
// archive with ranged GETs in DATA_REGION (IC-WBT's tiles bucket, docs/data.md § Cross-account access,
// row 3); `http(s)://…` a server of the same archive. Unset or empty is "not configured" (a 503).
// DEM_LABEL names the dataset on every delineation (default: the archive's own name).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CopyUnavailableError, DEFAULT_BUCKET_REGION } from '../chirps/copy.js';
import { openDem, type Dem, type DemInfo } from './dem.js';

export const DEFAULT_DEM_LOCAL_FILE = '.local/dem/synthetic.pmtiles';

/** The Copernicus WorldDEM-30 licence's Art. 6(b) notice, word for word, with Mapterhorn's credit (docs/data.md § DEM). */
export const COPERNICUS_NOTICE =
	'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. © Mapterhorn';

export type DemLocation = { kind: 'local'; file: string; label?: string } | { kind: 'remote'; url: string; label?: string; region: string } | { problem: string };

type Env = Record<string, string | undefined>;

/** The DEM the environment names, or what is wrong with the setting. */
export function demLocationFromEnv(env: Env = process.env): DemLocation {
	const source = (env.DEM_SOURCE ?? '').trim();
	const label = env.DEM_LABEL?.trim() || undefined;
	if (!source) return { problem: 'DEM_SOURCE is not set (local, s3://bucket/key or https://…)' };
	if (source === 'local') return { kind: 'local', file: resolve(env.DEM_LOCAL_FILE?.trim() || DEFAULT_DEM_LOCAL_FILE), label };
	if (/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/.+$/.test(source) || /^https?:\/\//.test(source)) {
		return { kind: 'remote', url: source, label, region: env.DATA_REGION?.trim() || DEFAULT_BUCKET_REGION };
	}
	return { problem: `DEM_SOURCE must be local, s3://bucket/key or https://…, not ${source.slice(0, 80)}` };
}

/** What a delineation reads: the DEM, and the notice its results must carry. */
export interface OpenDem {
	dem: Dem;
	info: DemInfo;
	/** Shown on every delineated polygon (docs/data.md § DEM, Licence). */
	attribution: string;
}

/** The configured DEM, opened once per instance. A failed open isn't kept, so the next request retries. */
export class DemSource {
	readonly location: DemLocation | Dem;
	#dem?: Dem;
	constructor(location: DemLocation | Dem) {
		this.location = location;
	}

	async open(): Promise<OpenDem> {
		const l = this.location;
		if ('problem' in l) throw new CopyUnavailableError(`the elevation model is not configured: ${l.problem}`);
		if ('kind' in l && l.kind === 'local' && !existsSync(l.file)) {
			throw new CopyUnavailableError(`there is no local elevation model at ${l.file}: run \`pnpm dev:data:synthetic\` to write the synthetic one, or set DEM_LOCAL_FILE`);
		}
		const dem = (this.#dem ??= 'info' in l ? l : l.kind === 'local' ? openDem(l.file, l.label) : openDem(l.url, l.label, { region: l.region }));
		let info: DemInfo;
		try {
			info = await dem.info();
		} catch (err) {
			console.error('DEM read failed', err);
			throw new CopyUnavailableError('the elevation model could not be read just now; try again shortly');
		}
		return { dem, info, attribution: 'kind' in l && l.kind === 'remote' ? COPERNICUS_NOTICE : info.attribution };
	}
}
