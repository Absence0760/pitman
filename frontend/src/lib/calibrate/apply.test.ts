import { syntheticSamiParameters, writeBundle, type RunoffModule, type Sidecar } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { syntheticBundle } from '#lib/network/synthetic.js';
import { calibrationLog, changeNote, fileValue, parameterChanges, saveCheck, withCalibration, withChanges, withModule, type ParameterChange } from './apply.js';
import { parameterFields } from './parameters.js';

const bundle = syntheticBundle();
const module = bundle.modules.find((m) => m.kind === 'RU') as RunoffModule;
const fields = parameterFields(module);
const field = (symbol: string) => fields.find((f) => f.symbol === symbol)!;
const NOW = new Date('2026-10-30T08:00:00Z');

const change = (symbol: string, to: number): ParameterChange => {
	const f = field(symbol);
	return { field: f, from: module.pitman[symbol as 'ST'], to };
};

describe('parameterChanges', () => {
	it('lists only the fields that differ, in field order', () => {
		const values = { 'pitman.ST': 400, 'pitman.POW': 3, 'pitman.R': module.pitman.R };
		expect(parameterChanges(module, fields, values).map((c) => c.field.symbol)).toEqual(['POW', 'ST']);
	});
});

describe('changeNote', () => {
	it('holds both values at the file’s precision, and the reason', () => {
		expect(changeNote({ field: field('POW'), from: 2, to: 3 })).toBe('Calibration: 2.0 → 3.0');
		expect(changeNote({ field: field('POW'), from: 2, to: 3 }, ' fits the low flows ')).toBe('Calibration: 2.0 → 3.0; fits the low flows');
	});
});

describe('withCalibration', () => {
	const next = withCalibration(bundle, module, [change('ST', 400), change('POW', 3)], { reason: 'peak flows', now: NOW });
	const updated = next.modules.find((m) => m.kind === 'RU' && m.number === module.number) as RunoffModule;

	it('changes the active set of that module and no other', () => {
		expect(updated.pitman.ST).toBe(400);
		expect(updated.pitman.POW).toBe(3);
		expect(next.modules.filter((m) => m !== updated)).toEqual(bundle.modules.filter((m) => m !== module));
		expect(module.pitman.ST).not.toBe(400);
	});

	it('records what changed, from what, and when, in the sidecar', () => {
		expect(next.sidecar?.values).toEqual([
			{ target: { module: { type: 'RU', number: module.number }, field: 'pitman.ST' }, source: { kind: 'manual', note: `Calibration: ${module.pitman.ST} → 400; peak flows`, date: NOW.toISOString() } },
			{ target: { module: { type: 'RU', number: module.number }, field: 'pitman.POW' }, source: { kind: 'manual', note: 'Calibration: 2.0 → 3.0; peak flows', date: NOW.toISOString() } }
		]);
	});

	it('keeps what the sidecar already held', () => {
		const sidecar: Sidecar = { schema: 'pitman-sidecar', schemaVersion: 1, writtenBy: 'earlier', values: [{ target: { field: 'other' }, source: { kind: 'manual' } }] };
		const again = withCalibration({ ...bundle, sidecar }, module, [change('ST', 400)], { now: NOW });
		expect(again.sidecar?.writtenBy).toBe('earlier');
		expect(again.sidecar?.values).toHaveLength(2);
	});

	it('writes the same numbers to the network file', () => {
		const files = writeBundle(next);
		const text = Object.entries(files).find(([path]) => /RU1\.DAT$/i.test(path))?.[1] ?? '';
		expect(text).toContain('400');
		expect(text).toContain('   3.0');
	});
});

describe('fileValue and calibrationLog', () => {
	const first = withCalibration(bundle, module, [change('ST', 400)], { now: NOW, reason: 'one' });
	const moved = first.modules.find((m) => m.kind === 'RU' && m.number === module.number) as RunoffModule;
	const second = withCalibration(first, moved, [{ field: field('ST'), from: 400, to: 410 }], { now: NOW });
	const twice = second.modules.find((m) => m.kind === 'RU' && m.number === module.number) as RunoffModule;

	it('keeps every change, oldest first', () => {
		expect(calibrationLog(second.sidecar, module.number, 'pitman.ST')).toEqual([
			{ from: module.pitman.ST, to: 400, reason: 'one', date: NOW.toISOString() },
			{ from: 400, to: 410, reason: '', date: NOW.toISOString() }
		]);
	});

	it('keeps the file’s value of a note a split copied, but not of one it divided or scaled', () => {
		const ru = (number: number) => ({ type: 'RU', number }) as const;
		const split = (how: 'copied' | 'divided') => ({ quaternary: 'Z01A', from: ru(module.number), how, pieces: [ru(16), ru(module.number)], ...(how === 'divided' ? { whole: 400, part: 100 } : {}) });
		const sidecar = (how: 'copied' | 'divided'): Sidecar => ({
			schema: 'pitman-sidecar',
			schemaVersion: 1,
			values: [{ target: { module: ru(module.number), field: 'pitman.ST' }, source: { kind: 'manual', note: 'Calibration: 150 → 400; peak flows', date: NOW.toISOString() }, splits: [split(how)] }]
		});
		const piece: RunoffModule = { ...module, pitman: { ...module.pitman, ST: 100 } };
		expect(fileValue(sidecar('copied'), piece, 'pitman.ST')).toBe(150);
		expect(fileValue(sidecar('divided'), piece, 'pitman.ST')).toBe(100);
		expect(calibrationLog(sidecar('copied'), module.number, 'pitman.ST')[0]?.reshaped).toBeUndefined();
		expect(calibrationLog(sidecar('divided'), module.number, 'pitman.ST')[0]?.reshaped).toBe(`divided among RU 16 and RU ${module.number} when Z01A was sub-divided: 100 here of 400`);
	});

	it('remembers the network file’s value through later edits', () => {
		expect(fileValue(second.sidecar, twice, 'pitman.ST')).toBe(module.pitman.ST);
	});

	it('is the value in use when nothing was logged', () => {
		expect(fileValue(undefined, module, 'pitman.ST')).toBe(module.pitman.ST);
		expect(fileValue(second.sidecar, twice, 'pitman.POW')).toBe(module.pitman.POW);
	});

	it('survives a save and reload as JSON', () => {
		const sidecar = JSON.parse(JSON.stringify(second.sidecar)) as Sidecar;
		expect(fileValue(sidecar, twice, 'pitman.ST')).toBe(module.pitman.ST);
	});

	it('tells modules apart and skips notes it didn’t write', () => {
		const sidecar: Sidecar = {
			schema: 'pitman-sidecar',
			schemaVersion: 1,
			values: [
				{ target: { module: { type: 'RU', number: 99 }, field: 'pitman.ST' }, source: { kind: 'manual', note: 'Calibration: 1 → 2' } },
				{ target: { module: { type: 'RU', number: module.number }, field: 'pitman.ST' }, source: { kind: 'manual', note: 'typed from a report' } }
			]
		};
		expect(calibrationLog(sidecar, module.number, 'pitman.ST')).toEqual([]);
	});
});

describe('withModule', () => {
	it('replaces only the runoff module of that number', () => {
		const next = withModule(bundle, { ...module, name: 'Renamed' });
		expect(next.modules.filter((m) => m.kind === 'RU' && m.name === 'Renamed')).toHaveLength(1);
		expect(next.modules).toHaveLength(bundle.modules.length);
	});
});

describe('saveCheck', () => {
	const sami: RunoffModule = { ...module, groundwaterModel: 2, sami: syntheticSamiParameters(module.pitman) };

	it('finds nothing when the file holds every value', () => {
		expect(saveCheck(withChanges(module, [change('ST', 400)]), fields)).toEqual({ rounded: [], problem: null });
		expect(saveCheck(sami, parameterFields(sami)).rounded).toEqual([]);
	});

	it('names a value with more decimals than the file keeps', () => {
		const odd = { ...module, pitman: { ...module.pitman, POW: 2.55 } };
		expect(saveCheck(odd, fields).rounded).toEqual(['POW']);
	});

	it('reports a value that can’t be written, without throwing', () => {
		const huge = { ...module, pitman: { ...module.pitman, FT: 1e9 } };
		expect(saveCheck(huge, fields).problem).toContain('FT');
	});
});
