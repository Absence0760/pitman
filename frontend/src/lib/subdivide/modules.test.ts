import type { QuaternaryCollection, Sidecar, Subdivision } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { QUATERNARY, workedBundle } from './fixtures.test-helper.js';
import { choicesFor, doneRows, featureOf, quaternaryGroups, quaternaryInName, runoffChoices, splitBlock, subdivisionOf } from './modules.js';

const feature = (code: string) => ({ type: 'Feature' as const, properties: { code }, geometry: QUATERNARY });
const COLLECTION: QuaternaryCollection = { type: 'FeatureCollection', source: 'Synthetic', features: [feature('Z03C'), feature('Z01A'), feature('Z02B'), feature('Z01A')] };

const SUBDIVISION: Subdivision = {
	quaternary: 'Z01A',
	method: 'hydrological',
	original: { type: 'RU', number: 3 },
	pieces: [
		{ module: { type: 'RU', number: 16 }, areaKm2: 120, mapMm: 765, gridMap: { grid: 'g', cellSizeM: 100, cellCount: 1, meanMapMm: 820, fetchedOn: '2026-10-30' } },
		{ module: { type: 'RU', number: 3 }, areaKm2: 280, mapMm: 569, gridMap: { grid: 'g', cellSizeM: 100, cellCount: 1, meanMapMm: 610, fetchedOn: '2026-10-30' } }
	],
	calibration: { targetNaturalMarMm3: 24, targetSource: 'hand-entered: WR2012, table 2', period: { startYear: 1920, endYear: 2009 }, tolerancePercent: 2, iterations: [], finalFactor: 0.9325, converged: true }
};

const sidecar = (subdivisions: readonly Subdivision[]): Sidecar => ({ schema: 'pitman-sidecar', schemaVersion: 1, subdivisions });

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
	const bundle = workedBundle({ sidecar: sidecar([SUBDIVISION]) });

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

	it('says when the best factor was used, and when nothing was calibrated', () => {
		const best = { ...SUBDIVISION, calibration: { ...(SUBDIVISION.calibration as NonNullable<Subdivision['calibration']>), converged: false } };
		expect(doneRows(workedBundle({ sidecar: sidecar([best]) }))[0]?.status).toBe('Not converged: best factor used, factor 0.9325');
		const { calibration: _, ...bare } = SUBDIVISION;
		expect(doneRows(workedBundle({ sidecar: sidecar([bare]) }))[0]?.status).toBe('Not calibrated');
	});
});
