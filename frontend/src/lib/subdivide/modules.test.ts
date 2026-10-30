import type { QuaternaryCollection, Sidecar, Subdivision } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { QUATERNARY, workedBundle } from './fixtures.test-helper.js';
import { choicesFor, doneRows, featureOf, quaternaryGroups, quaternaryInName, runoffChoices, splitBlock, subdivisionOf } from './modules.js';

const feature = (code: string) => ({ type: 'Feature' as const, properties: { code }, geometry: QUATERNARY });
const COLLECTION: QuaternaryCollection = { type: 'FeatureCollection', source: 'Synthetic', features: [feature('Z03C'), feature('Z01A'), feature('Z02B'), feature('Z01A')] };

const piece = (number: number, role: 'tributary' | 'outlet', areaKm2: number, gridMapMm: number, mapMm: number) => ({ role, number, polygonKm2: areaKm2, areaKm2, gridMapMm, mapMm, mapSource: 'grid' as const });

const SUBDIVISION: Subdivision = {
	method: 'subdivide-1',
	module: { type: 'RU', number: 3, areaKm2: 400, mapMm: 640 },
	splits: [{ kind: 'zone-drawn' }],
	pieces: [piece(16, 'tributary', 120, 820, 765), piece(3, 'outlet', 280, 610, 569)],
	grid: { dataset: 'g', cellDeg: 0.001, source: 's' },
	calibration: {
		target: { marMm3: 24, source: 'hand-entered: WR2012, table 2' },
		crossCheck: { marMm3: 23.7, source: 'unsplit module' },
		period: [1920, 2009],
		status: 'converged',
		factor: 0.9325,
		finalMarMm3: 24.098,
		iterations: []
	},
	shares: { afforestation: 'area', alien: 'area', dams: 'area' },
	farmDamPercent: 'original'
};

const sidecar = (subdivisions: Record<string, Subdivision>): Sidecar => ({ schema: 'pitman-sidecar', schemaVersion: 1, subdivisions });

describe('quaternaryInName', () => {
	it('finds a code anywhere in a module’s name, whatever its case', () => {
		expect(quaternaryInName('Z01A upper')).toBe('Z01A');
		expect(quaternaryInName('upper z01a')).toBe('Z01A');
		expect(quaternaryInName('RU-Z01A-2')).toBe('Z01A');
	});

	it('does not read a code out of a longer word or number', () => {
		expect(quaternaryInName('AZ01A')).toBeUndefined();
		expect(quaternaryInName('Z01AB')).toBeUndefined();
		expect(quaternaryInName('Synthetic 1')).toBeUndefined();
	});
});

describe('runoffChoices', () => {
	it('lists the runoff modules in .NET order and leaves SFR children to their parent', () => {
		const choices = runoffChoices(workedBundle());
		expect(choices.map((c) => c.label)).toEqual(['RU 3 Z01A upper', 'RU 7 Z02B']);
		expect(choices[1]?.sfrChildren).toBe(1);
		expect(choices[0]?.quaternary).toBe('Z01A');
	});

	it('offers the named modules first and keeps the rest one choice away', () => {
		const { named, others } = choicesFor(runoffChoices(workedBundle()), 'Z01A');
		expect(named.map((c) => c.ref.number)).toEqual([3]);
		expect(others.map((c) => c.ref.number)).toEqual([7]);
	});
});

describe('quaternaryGroups', () => {
	it('puts the codes the network names first, each group sorted, each code once', () => {
		expect(quaternaryGroups(COLLECTION, runoffChoices(workedBundle()))).toEqual({ inNetwork: ['Z01A', 'Z02B'], others: ['Z03C'] });
	});

	it('finds a feature by its code', () => {
		expect(featureOf(COLLECTION, 'Z02B')?.properties.code).toBe('Z02B');
		expect(featureOf(COLLECTION, 'Z09Z')).toBeUndefined();
	});
});

describe('a sub-division already applied', () => {
	const bundle = workedBundle({ sidecar: sidecar({ Z01A: SUBDIVISION }) });

	it('finds it from the original module or from a piece', () => {
		expect(subdivisionOf(bundle, { type: 'RU', number: 3 })?.quaternary).toBe('Z01A');
		expect(subdivisionOf(bundle, { type: 'RU', number: 16 })?.quaternary).toBe('Z01A');
		expect(subdivisionOf(bundle, { type: 'RU', number: 7 })).toBeUndefined();
	});

	it('blocks splitting it again, saying what to do instead', () => {
		expect(splitBlock(bundle, { type: 'RU', number: 16 })).toContain('go back to the zip saved before it');
		expect(splitBlock(bundle, { type: 'RU', number: 7 })).toBeNull();
		expect(splitBlock(workedBundle(), { type: 'RU', number: 3 })).toBeNull();
	});

	it('shows each piece, the target’s source and the state in words', () => {
		const [row] = doneRows(bundle);
		expect(row?.pieces).toBe('RU 16: 120.0 km², MAP 765 mm; RU 3: 280.0 km², MAP 569 mm');
		expect(row?.target).toBe('24.000 million m³/year (hand-entered: WR2012, table 2), 1920/21 to 2009/10');
		expect(row?.status).toBe('Converged, factor 0.9325');
	});

	it('says when the best factor was used', () => {
		const best: Subdivision = { ...SUBDIVISION, calibration: { ...SUBDIVISION.calibration, status: 'not_converged', acceptedNotConverged: true } };
		expect(doneRows(workedBundle({ sidecar: sidecar({ Z01A: best }) }))[0]?.status).toBe('Not converged: best factor used, factor 0.9325');
	});
});
