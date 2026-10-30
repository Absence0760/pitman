import { describe, expect, it } from 'vitest';
import { exampleBundle } from '../subdivide/fixtures.js';
import type { IrrigationModule, IrrigationWqtLayout, Module, ModuleRef, NetworkBundle, ValueSource } from '../types.js';
import { COMPOSITE_CROP, applyIrrigatedAreas, fieldIrrigated, irrigatedRowKm2, irrigationCropTypes, sumIrrigatedAreas } from './cfm.js';
import type { CropField } from './round7-contract.js';

const shape = { type: 'Polygon', coordinates: [[[21, -34], [21.1, -34], [21.1, -33.9], [21, -34]]] } as const;
const field = (id: string, crop: string, areaHa: number, irrigated: boolean | null): CropField => ({ id, crop, areaHa, irrigated, geometry: shape });
const source: ValueSource = { kind: 'capeFarmMapper', note: 'Invented census', date: '2026-10-30' };
const RR: ModuleRef = { type: 'RR', number: 7 };
const rr = (b: NetworkBundle) => b.modules.find((m): m is IrrigationModule => m.kind === 'RR')!;

/** The example's WQT block with a crop table of two types. */
function twoCrops(): NetworkBundle {
	const b = exampleBundle({ irrigation: 'wqt' });
	const module = rr(b) as IrrigationWqtLayout;
	const crops = [
		{ ...module.crops[0]!, percent: 60, description: 'Vines' },
		{ ...module.crops[0]!, percent: 40, description: 'Orchards' }
	];
	return { ...b, modules: b.modules.map((m): Module => (m === module ? { ...module, crops } : m)) };
}

describe('sumIrrigatedAreas', () => {
	const fields = [field('1', 'Wine grapes', 120, true), field('2', 'Wine grapes', 30, false), field('3', 'Apples', 50, null), field('4', 'Pears', 25, null), field('5', 'Wheat', 400, null), field('6', 'Citrus', 10, true)];
	const mapping = { 'Wine grapes': 'Vines', Apples: 'Orchards', Pears: 'Orchards', Wheat: null, Citrus: null };

	it('sums per mapped crop in km²: the layer’s word first, the user’s mark when it says nothing (D-8)', () => {
		// 120 ha irrigated grapes; the 30 ha the layer calls dryland stay out however the crop is marked.
		expect(sumIrrigatedAreas(fields, mapping, ['Apples', 'Pears', 'Wine grapes'])).toEqual([
			{ crop: 'Orchards', areaKm2: 0.75 },
			{ crop: 'Vines', areaKm2: 1.2 }
		]);
	});

	it('leaves out what is unmarked or mapped to null', () => {
		expect(sumIrrigatedAreas(fields, mapping, [])).toEqual([{ crop: 'Vines', areaKm2: 1.2 }]);
		expect(sumIrrigatedAreas(fields, mapping, ['Wheat'])).toEqual([{ crop: 'Vines', areaKm2: 1.2 }]);
	});

	it('refuses an irrigated crop with no mapping rather than dropping its area', () => {
		expect(() => sumIrrigatedAreas([field('1', 'Citrus', 1, true)], {}, [])).toThrow(/Citrus/);
		// A crop named like an Object member is still only the layer's text.
		expect(() => sumIrrigatedAreas([field('1', 'constructor', 1, true)], {}, [])).toThrow(/constructor/);
	});

	it('refuses an area that is not a number', () => {
		expect(() => sumIrrigatedAreas([field('1', 'Apples', Number.NaN, true)], { Apples: 'Orchards' }, [])).toThrow(/area/);
	});

	it('says which fields count', () => {
		expect(fieldIrrigated(field('1', 'Apples', 1, null), new Set(['Apples']))).toBe(true);
		expect(fieldIrrigated(field('1', 'Apples', 1, false), new Set(['Apples']))).toBe(false);
	});
});

describe('irrigationCropTypes', () => {
	it('is the crop table, or the composite crop for a module without one', () => {
		expect(irrigationCropTypes(rr(twoCrops()))).toEqual(['Vines', 'Orchards']);
		expect(irrigationCropTypes(rr(exampleBundle({ irrigation: true })))).toEqual([COMPOSITE_CROP]);
	});
});

describe('applyIrrigatedAreas', () => {
	const areas = [{ crop: 'Orchards', areaKm2: 0.75 }, { crop: 'Vines', areaKm2: 1.2 }];
	const mapping = { 'Wine grapes': 'Vines', Apples: 'Orchards', Wheat: null };

	it('adds the year’s row in order, at the file’s precision, and leaves the bundle it was given alone', () => {
		const before = twoCrops();
		const first = rr(before).areaKm2[0]!.year;
		const next = applyIrrigatedAreas(before, RR, 2025, areas, source, mapping);
		expect(rr(next).areaKm2.at(-1)).toEqual({ year: 2025, value: 1.95 });
		expect(rr(next).areaKm2.map((r) => r.year)).toEqual([...rr(before).areaKm2.map((r) => r.year), 2025]);
		expect(rr(before).areaKm2.some((r) => r.year === 2025)).toBe(false);
		const between = applyIrrigatedAreas(before, RR, first + 1, areas, source, mapping);
		expect(rr(between).areaKm2[1]).toEqual({ year: first + 1, value: 1.95 });
	});

	it('replaces the row of a year it already has', () => {
		const once = applyIrrigatedAreas(twoCrops(), RR, 2025, areas, source, mapping);
		const twice = applyIrrigatedAreas(once, RR, 2025, [{ crop: 'Vines', areaKm2: 3.333 }], source, mapping);
		expect(rr(twice).areaKm2.filter((r) => r.year === 2025)).toEqual([{ year: 2025, value: 3.33 }]);
	});

	it('sets CPF to the shares, adding to exactly 100, and records what it replaced (R7-C1)', () => {
		const next = applyIrrigatedAreas(twoCrops(), RR, 2025, [{ crop: 'Orchards', areaKm2: 1 }, { crop: 'Vines', areaKm2: 2 }], source, mapping);
		const crops = (rr(next) as IrrigationWqtLayout).crops;
		expect(crops.map((c) => c.percent)).toEqual([66.67, 33.33]);
		const note = next.sidecar?.values?.find((v) => v.target.field === 'crops.percent');
		expect(note?.source.note).toBe('Invented census; was Vines 60 %, Orchards 40 %');
	});

	it('keeps the crop table when nothing is irrigated, and notes no change on a composite module', () => {
		const none = applyIrrigatedAreas(twoCrops(), RR, 2025, [], source, {});
		expect((rr(none) as IrrigationWqtLayout).crops.map((c) => c.percent)).toEqual([60, 40]);
		expect(rr(none).areaKm2.at(-1)).toEqual({ year: 2025, value: 0 });
		const composite = applyIrrigatedAreas(exampleBundle({ irrigation: 'wqt' }), RR, 2025, [{ crop: 'composite', areaKm2: 2 }], source, {});
		expect(composite.sidecar?.values?.map((v) => v.target.field)).toEqual(['areaKm2']);
	});

	it('writes a module without a crop table', () => {
		const next = applyIrrigatedAreas(exampleBundle({ irrigation: true }), RR, 2025, [{ crop: COMPOSITE_CROP, areaKm2: 1.5 }], source, {});
		expect(rr(next).areaKm2.at(-1)).toEqual({ year: 2025, value: 1.5 });
		expect(rr(next).layout).toBe('pitman');
	});

	it('records the fetch, the mapping and the value’s source in the sidecar', () => {
		const next = applyIrrigatedAreas(twoCrops(), RR, 2025, areas, source, mapping);
		expect(next.sidecar?.capeFarmMapper).toEqual({ fetchedOn: '2026-10-30', dataset: 'Invented census', cropMapping: { 'Wine grapes': 'Vines', Apples: 'Orchards' } });
		expect(next.sidecar?.values).toContainEqual({ target: { module: RR, field: 'areaKm2', year: 2025 }, source });
		const again = applyIrrigatedAreas(next, RR, 2025, areas, source, { Apples: null, Pears: 'Orchards' });
		expect(again.sidecar?.capeFarmMapper?.cropMapping).toEqual({ 'Wine grapes': 'Vines', Pears: 'Orchards' });
		expect(again.sidecar?.values?.filter((v) => v.target.field === 'areaKm2')).toHaveLength(1);
	});

	it('refuses what it can’t write', () => {
		const b = twoCrops();
		expect(() => applyIrrigatedAreas(b, { type: 'RR', number: 99 }, 2025, areas, source, {})).toThrow(/RR 99/);
		expect(() => applyIrrigatedAreas(b, { type: 'RV', number: 2 }, 2025, areas, source, {})).toThrow(/RV 2/);
		expect(() => applyIrrigatedAreas(b, RR, 2025.5, areas, source, {})).toThrow(/year/);
		expect(() => applyIrrigatedAreas(b, RR, 2025, [{ crop: 'Wheat', areaKm2: 1 }], source, {})).toThrow(/no crop type "Wheat"/);
		expect(() => applyIrrigatedAreas(b, RR, 2025, areas, { kind: 'capeFarmMapper' }, {})).toThrow(/fetch date/);
		const module = rr(b) as IrrigationWqtLayout;
		const wqt4 = { ...b, modules: b.modules.map((m) => (m === module ? ({ ...module, layout: 'wqt4' } as unknown as Module) : m)) };
		expect(() => applyIrrigatedAreas(wqt4, RR, 2025, areas, source, {})).toThrow(/WQT type 4/);
	});

	it('rounds the row as the file does', () => {
		expect(irrigatedRowKm2([{ crop: 'a', areaKm2: 0.004 }])).toBe(0);
		expect(irrigatedRowKm2([{ crop: 'a', areaKm2: 1.236 }, { crop: 'b', areaKm2: 1 }])).toBe(2.24);
	});
});
