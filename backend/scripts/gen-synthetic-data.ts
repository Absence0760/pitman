// Writes the local-first data the dev server reads when CHIRPS_SOURCE=local and MAP_GRID_SOURCE=local
// (the defaults in backend/.env.development): a deterministic synthetic CHIRPS copy from 1981 to the
// last complete month, and a synthetic MAP grid over the same invented area. Invented values only.
//
//   pnpm dev:data:synthetic                      (root; = pnpm -C backend exec tsx scripts/gen-synthetic-data.ts)
//   … --out .local --through 2026-09 --seed 20261029
//
// Output (gitignored, backend/.gitignore): <out>/mirror/ (Zarr v3 + rnl/manifest.json, ~2 MB) and
// <out>/map-grid/synthetic.json. Paths are relative to backend/, where the dev server runs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_SEED, lastCompleteMonthEnd, writeSyntheticChirps } from '../src/chirps/synthetic.js';
import { daysInMonth } from '../src/chirps/mirror/calendar.js';
import { syntheticMapGridJson } from '../src/mapgrid/synthetic.js';

const { values } = parseArgs({
	options: {
		out: { type: 'string', default: '.local' },
		through: { type: 'string' },
		seed: { type: 'string', default: String(DEFAULT_SEED) }
	}
});

function throughDay(v: string | undefined): string {
	if (v === undefined) return lastCompleteMonthEnd();
	const m = /^(\d{4})-(\d{2})$/.exec(v);
	if (!m) throw new Error(`--through takes a month, YYYY-MM, not ${v}`);
	return `${v}-${String(daysInMonth(Number(m[1]), Number(m[2]))).padStart(2, '0')}`;
}

const out = resolve(values.out);
const through = throughDay(values.through);
const seed = Number(values.seed);
if (!Number.isInteger(seed)) throw new Error('--seed takes a whole number');

const t0 = Date.now();
const manifest = await writeSyntheticChirps({ dir: resolve(out, 'mirror'), through, seed });
console.log(`synthetic CHIRPS copy: ${resolve(out, 'mirror')} (1981-01 to ${through}, ${manifest.files.length} months, ${Date.now() - t0} ms)`);

const gridFile = resolve(out, 'map-grid', 'synthetic.json');
mkdirSync(dirname(gridFile), { recursive: true });
writeFileSync(gridFile, syntheticMapGridJson());
console.log(`synthetic MAP grid: ${gridFile}`);
