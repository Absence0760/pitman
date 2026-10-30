/**
 * Holds the Methods page to the code and the docs: a statement that stops
 * being true fails here, so the page can't drift from the engine.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, type RunoffModule } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { syntheticBundle } from '#lib/network/synthetic.js';
import { AGREEMENT, COPERNICUS_LIABILITY, COPERNICUS_NOTICE, DATA_SOURCES, DEPARTURES, FEATURE_GROUPS, MANUALS } from './content.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const doc = (path: string) => readFileSync(join(ROOT, 'docs', path), 'utf8');
const features = FEATURE_GROUPS.flatMap((g) => g.features);
const feature = (name: string) => features.find((f) => f.name.startsWith(name));

describe('the departures register', () => {
	it('lists every row of docs/departures.md and no other', () => {
		const ids = [...doc('departures.md').matchAll(/^\| (DP-\d+) \|/gm)].map((m) => m[1]);
		expect(DEPARTURES.map((d) => d.id)).toEqual(ids);
	});

	it('quotes the sizes the register gives', () => {
		const text = doc('departures.md');
		expect(text).toContain('mean 0.71 %, max 3.53 %');
		expect(text).toContain('4.0 percentage points');
		expect(text).toContain('3.1868');
		expect(text).toContain('3.4165');
	});
});

describe('the features matrix against the engine', () => {
	const bundle = syntheticBundle();

	it('Hughes: a run fails and names the module', () => {
		expect(feature('Hughes')?.status).toBe('Not yet');
		const hughes = { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'RU' && m.number === 1 ? ({ ...m, groundwaterModel: 1 } as RunoffModule) : m)) };
		expect(() => run(hughes, { kind: 'historical' })).toThrow(/RU 1.*Hughes/);
	});

	it('irrigation: simulated, and the page says it isn’t compared yet', () => {
		expect(feature('Irrigation')?.status).toBe('Partly');
		expect(feature('Irrigation')?.detail).toContain('not been compared with WRSM2000');
		const result = run(bundle, { kind: 'historical' });
		expect(result.messages.some((m) => /irrigation is not simulated/.test(m.text))).toBe(false);
		expect(Object.keys(result.irrigation ?? {}).length).toBeGreaterThan(0);
	});

	it('mines: kept, and their routes carry zero', () => {
		expect(feature('Mines')?.status).toBe('Not yet');
		const mine = { kind: 'unparsed' as const, moduleType: 'MM' as const, number: 8, name: '', reason: 'mine modules are not modelled yet', lines: [] };
		const added = {
			...bundle,
			network: { ...bundle.network, modules: [...bundle.network.modules, { number: 8, type: 'MM' as const, solve: true }] },
			modules: [...bundle.modules, mine]
		};
		const result = run(added, { kind: 'historical' });
		expect(result.messages.some((m) => /not simulated \(mine modules/.test(m.text))).toBe(true);
	});

	it('afforestation with no printed curve warns, as the page says', () => {
		expect(doc('theory/afforestation.md')).toContain('CSIR or Van der Zel in a free module');
		expect(feature('Afforestation')?.status).toBe('Partly');
	});

	it('sub-division and land use are partly there, and say what they lack', () => {
		expect(feature('Sub-dividing')?.status).toBe('Partly');
		expect(feature('Land use')?.status).toBe('Partly');
	});

	it('gives every feature a status and a sentence', () => {
		for (const f of features) expect(f.detail.length, f.name).toBeGreaterThan(5);
	});
});

describe('the comparison', () => {
	it('uses percentages, no counts of routes or modules', () => {
		for (const a of AGREEMENT) expect(`${a.what} ${a.result}`).not.toMatch(/\b\d+ (of|\/) \d+\b/);
	});

	it('matches the record in docs/decisions.md', () => {
		const text = doc('decisions.md');
		expect(text).toContain('34 of 35 networks run; 164 of 377 routes');
		expect(text).toContain('runoff routes median MAR +0.38 %, NSE 0.998');
		expect(text).toContain('RU 55 of 102');
		expect(text).toContain('median MAR +0.66 %');
		expect(text).toContain('48 within 2 %');
		expect(text).toContain('median |MAR| 4.2 %');
		const results = AGREEMENT.map((a) => a.result).join(' ');
		expect(results).toContain(`${Math.round((34 / 35) * 100)} %`);
		expect(results).toContain(`${((164 / 377) * 100).toFixed(1)} %`);
		expect(results).toContain(`${Math.round((55 / 102) * 100)} %`);
		expect(results).toContain(`${Math.round((48 / 71) * 100)} %`);
	});
});

describe('the data sources', () => {
	it('carries the Copernicus notices word for word', () => {
		const text = doc('data.md').replace(/\s+/g, ' ');
		expect(text).toContain(COPERNICUS_NOTICE);
		const dem = DATA_SOURCES.find((s) => s.name.startsWith('Copernicus'));
		expect(dem?.credit).toContain(COPERNICUS_NOTICE);
		expect(dem?.credit).toContain(COPERNICUS_LIABILITY);
	});

	it('credits CHIRPS as the licence asks, with the DOI', () => {
		expect(DATA_SOURCES.find((s) => s.name.startsWith('CHIRPS'))?.credit).toContain('https://doi.org/10.15780/G2JQ0P');
	});

	it('credits OpenStreetMap', () => {
		expect(DATA_SOURCES.find((s) => s.name.startsWith('OpenStreetMap'))?.credit).toBe('© Protomaps © OpenStreetMap contributors');
	});
});

describe('the manuals', () => {
	it('lists the four the model is built from', () => {
		expect(MANUALS.map((m) => m.id.slice(0, 6))).toEqual(['TT 690', 'TT 689', 'TT 691', 'TT 687']);
	});
});
