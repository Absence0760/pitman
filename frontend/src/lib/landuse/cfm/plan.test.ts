import { describe, expect, it } from 'vitest';
import { matchDams, syntheticNetwork, type DamRecord, type IrrigationModule, type NetworkBundle, type ReservoirModule } from '@pitman/wrsm';
import { ANSWER, box, field } from './fixtures.test-helper.js';
import { confirmedMapping, countedHa, cropRows, damMarkers, damName, fieldsShape, irrigationChoices, reservoirChoices, sourceLabel, startingChoice, undecidedCrops, validYear, type CropChoice } from './plan.js';

const rows = cropRows(ANSWER.fields);

describe('cropRows', () => {
	it('groups by crop, the largest first, by what the layer says', () => {
		expect(rows.map((r) => r.crop)).toEqual(['Wheat', 'Wine grapes', 'Lucerne']);
		expect(rows[1]).toEqual({ crop: 'Wine grapes', fields: 2, totalHa: 150, irrigatedHa: 120, dryHa: 30, unknownHa: 0 });
		expect(rows[2]).toEqual({ crop: 'Lucerne', fields: 1, totalHa: 80, irrigatedHa: 0, dryHa: 0, unknownHa: 80 });
	});

	it('takes a crop named like an Object member as any other', () => {
		expect(cropRows([field('1', 'constructor', 1, true)])[0]!.crop).toBe('constructor');
	});

	it('counts the unknown hectares only when the crop is marked', () => {
		expect(countedHa(rows[2]!, false)).toBe(0);
		expect(countedHa(rows[2]!, true)).toBe(80);
		expect(countedHa(rows[1]!, false)).toBe(120);
	});
});

describe('the crop mapping', () => {
	it('starts from the saved mapping, then the only type, then the same name, and guesses no further', () => {
		expect(startingChoice('Apples', ['Orchards', 'Vines'], { Apples: 'Orchards' })).toBe('Orchards');
		expect(startingChoice('Apples', ['composite'])).toBe('composite');
		expect(startingChoice(' LUCERNE ', ['Lucerne', 'Vines'])).toBe('Lucerne');
		expect(startingChoice('Apples', ['Orchards', 'Vines'])).toBeUndefined();
		// A saved type this module doesn't have, or a crop named like an Object member, isn't a match.
		expect(startingChoice('Apples', ['Vines', 'Wheat'], { Apples: 'Orchards' })).toBeUndefined();
		expect(startingChoice('constructor', ['Vines', 'Wheat'], {})).toBeUndefined();
	});

	it('waits for a decision on each crop that counts, “leave out” being one', () => {
		const choice = new Map<string, CropChoice>([['Lucerne', null]]);
		expect(undecidedCrops(rows, (c) => choice.get(c), new Set())).toEqual(['Wine grapes']);
		expect(undecidedCrops(rows, () => undefined, new Set(['Lucerne']))).toEqual(['Wine grapes', 'Lucerne']);
		expect(undecidedCrops(rows, () => null, new Set(['Lucerne']))).toEqual([]);
	});

	it('names every crop for the engine, mapping only those that count', () => {
		expect(confirmedMapping(rows, () => 'composite', new Set())).toEqual({ Wheat: null, 'Wine grapes': 'composite', Lucerne: null });
		expect(confirmedMapping(rows, () => 'composite', new Set(['Lucerne']))).toEqual({ Wheat: null, 'Wine grapes': 'composite', Lucerne: 'composite' });
		expect(confirmedMapping(rows, () => undefined, new Set())['Wine grapes']).toBeNull();
	});
});

describe('the modules on offer', () => {
	const bundleWith = (extra: NetworkBundle['modules']) => {
		const base = syntheticNetwork({ code: 'Z1', startYear: 1990, years: 5 });
		return { network: base.network, modules: extra, rainfall: {}, observed: {}, flowFiles: {} } as unknown as NetworkBundle;
	};
	const rr = (number: number, layout: string, crops: readonly string[] = []) => ({ kind: 'RR', number, name: ` Block ${number} `, layout, areaKm2: [{ year: 2000, value: 1 }], crops: crops.map((description) => ({ description })) }) as unknown as IrrigationModule;

	it('lists irrigation modules with their crop types, refusing WQT type 4 in words', () => {
		const choices = irrigationChoices(bundleWith([rr(1, 'pitman'), rr(2, 'wqt', ['Vines']), rr(3, 'wqt4', ['Vines']) ]));
		expect(choices.map((c) => [c.label, c.types, c.refused !== undefined])).toEqual([
			['RR 1, Block 1', ['composite'], false],
			['RR 2, Block 2', ['Vines'], false],
			['RR 3, Block 3', ['Vines'], true]
		]);
	});

	it('puts the reservoirs fed by one runoff module first, and keeps the rest', () => {
		const network = { modules: [{ number: 1, type: 'RU', solve: true }, { number: 2, type: 'RV', solve: true }, { number: 3, type: 'RV', solve: true }, { number: 4, type: 'CR', solve: true }], routes: [{ number: 1, upstreamPosition: 4, downstreamPosition: 2, cost: 0 }, { number: 2, upstreamPosition: 1, downstreamPosition: 3, cost: 0 }] };
		const rv = (number: number) => ({ kind: 'RV', number, name: `Dam ${number}`, capacity: [] }) as unknown as ReservoirModule;
		const b = { ...bundleWith([rv(2), rv(3)]), network } as unknown as NetworkBundle;
		expect(reservoirChoices(b).map((c) => [c.ref.number, c.farmDam])).toEqual([[3, true], [2, false]]);
	});
});

describe('validYear', () => {
	it('takes a whole year in the range', () => {
		expect([2025, 1900, 2100].every(validYear)).toBe(true);
		expect([null, 2025.5, 1899, 2101, Number.NaN].some(validYear)).toBe(false);
	});
});

describe('what the map draws', () => {
	it('sends the fields as one shape, Polygons and MultiPolygons alike', () => {
		const two = { ...field('2', 'a', 1, true), geometry: { type: 'MultiPolygon', coordinates: [box(21, -34, 21.1, -33.9).coordinates] } } as ReturnType<typeof field>;
		expect(fieldsShape([field('1', 'a', 1, true), two])?.coordinates).toHaveLength(2);
		expect(fieldsShape([])).toBeNull();
	});

	it('names a dam under the pointer by its name, without the method’s remark', () => {
		const [dam] = matchDams([{ id: 'x', source: 'surfaceWater', lon: 21, lat: -34, areaKm2: 0.01 }], { matchRadiusM: 100, fetchedOn: '2026-10-30' });
		expect(damName(dam!)).toBe('x');
		const [none] = matchDams([{ id: 'y', source: 'surfaceWater', lon: 21, lat: -34, name: 'Upper' }], { matchRadiusM: 100, fetchedOn: '2026-10-30' });
		expect(damName(none!)).toBe('Upper');
		expect(damMarkers([dam as DamRecord])).toEqual([{ id: 'x', label: 'Dam: x', lngLat: [21, -34] }]);
	});
});

describe('sourceLabel', () => {
	it('says where a capacity came from, a measured one as such', () => {
		expect(sourceLabel('damRegister')).toBe('Register of dams');
		expect(sourceLabel('capeFarmMapper', 'x')).toBe('Cape Farm Mapper');
		expect(sourceLabel('capeFarmMapper', 'x: area × 3 m')).toBe('Cape Farm Mapper area × 3 m');
		expect(sourceLabel('surfaceWater', 'x: area × 3 m')).toBe('Satellite area × 3 m');
		expect(sourceLabel('manual', 'a survey')).toBe('Typed in');
	});
});
