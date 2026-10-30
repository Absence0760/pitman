import { describe, expect, it } from 'vitest';

import type { Module, Network, RunoffModule, ValueEntry, ValueSplit } from '../types.js';
import { exampleBundle } from './fixtures.js';
import { carryValues, describeValueSplit, distinctValues } from './values.js';

const RU3 = { type: 'RU', number: 3 } as const;
const RU16 = { type: 'RU', number: 16 } as const;
const source = { kind: 'manual', note: 'Survey', date: '2026-10-30' } as const;
const split = (how: ValueSplit['how'], extra: Partial<ValueSplit> = {}): ValueSplit => ({ quaternary: 'Z01A', from: RU3, how, pieces: [RU16, RU3], ...extra });

describe('carryValues', () => {
	const hughes = { upperAbstraction: { annual: 4 }, riparianAbstraction: { annual: 2 } } as unknown as RunoffModule['hughes'];
	const bundle = exampleBundle();
	const before = bundle.modules.map((m): Module => (m.kind === 'RU' && m.number === 3 ? { ...m, hughes: hughes! } : m));
	const part = (annual: number) => ({ upperAbstraction: { annual }, riparianAbstraction: { annual: annual / 2 } }) as unknown as RunoffModule['hughes'];
	const after = before.flatMap((m): Module[] => (m.kind === 'RU' && m.number === 3 ? [{ ...m, number: 16, hughes: part(1)! }, { ...m, hughes: part(3)! }] : [m]));
	const network: Network = { ...bundle.network, modules: [...bundle.network.modules, { number: 16, type: 'RU', solve: true }] };
	const carry = { quaternary: 'Z01A', before, after: { network, modules: after }, lineage: [{ kind: 'runoff' as const, from: RU3, pieces: [RU16, RU3] }], rescaled: [] };

	it('divides the Hughes abstraction volumes, which `applySplit` splits with the area', () => {
		const out = carryValues([{ target: { module: RU3, field: 'hughes.upperAbstraction.annual' }, source }], carry);
		expect(out.map((v) => v.splits![0]!)).toEqual([split('divided', { whole: 4, part: 1 }), split('divided', { whole: 4, part: 3 })]);
	});

	it('copies a field a sub-division doesn’t list, the safe side of the rule: a piece reads the module’s note', () => {
		const out = carryValues([{ target: { module: RU3, field: 'someDayField' }, source }], carry);
		expect(out.map((v) => v.target.module)).toEqual([RU16, RU3]);
		expect(out[0]!.splits![0]!.how).toBe('copied');
	});

	it('covers the paths below a listed field, and leaves a module its own wiring', () => {
		const entry: ValueEntry = { target: { module: RU3, field: 'outflows.percent' }, source };
		expect(carryValues([entry], carry)).toEqual([entry]);
	});

	it('retires a note on a module’s own value the split changed', () => {
		const changed = after.map((m): Module => (m.kind === 'RU' && m.number === 3 ? { ...m, inflowRoute: 70 } : m));
		const out = carryValues([{ target: { module: RU3, field: 'inflowRoute' }, source }], { ...carry, after: { network, modules: changed } });
		expect(out[0]!.retired?.reason).toBe('the sub-division changed this value');
	});

	it('keeps the order of the log, one entry’s copies together', () => {
		const out = carryValues(
			[
				{ target: { module: RU3, field: 'pitman.ST' }, source },
				{ target: { module: { type: 'RU', number: 15 }, field: 'pitman.ST' }, source },
				{ target: { module: RU3, field: 'pitman.POW' }, source }
			],
			carry
		);
		expect(out.map((v) => `${v.target.module!.number} ${v.target.field}`)).toEqual(['16 pitman.ST', '3 pitman.ST', '15 pitman.ST', '16 pitman.POW', '3 pitman.POW']);
	});
});

describe('distinctValues', () => {
	const copy = (number: number, splits: readonly ValueSplit[]): ValueEntry => ({ target: { module: { type: 'RU', number }, field: 'pitman.ST' }, source, splits });

	it('counts a split’s copies of one note once, through later splits too', () => {
		const first = split('copied');
		const second = { ...split('copied'), from: RU16 };
		expect(distinctValues([copy(16, [first, second]), copy(17, [first, second]), copy(3, [first])])).toHaveLength(1);
	});

	it('keeps every entry no split touched, however alike, and different notes', () => {
		const plain: ValueEntry = { target: { module: RU3, field: 'pitman.ST' }, source };
		const other: ValueEntry = { ...copy(16, [split('copied')]), source: { ...source, note: 'Another' } };
		expect(distinctValues([plain, plain, copy(16, [split('copied')]), other])).toHaveLength(4);
	});
});

describe('describeValueSplit', () => {
	it('says how the value got here, with the figures when it has them', () => {
		expect(describeValueSplit(split('copied'))).toBe('copied to RU 16 and RU 3 when Z01A was sub-divided');
		expect(describeValueSplit(split('moved', { pieces: [RU16] }))).toBe('moved from RU 3 to RU 16 when Z01A was sub-divided');
		expect(describeValueSplit(split('divided', { whole: 16, part: 4 }))).toBe('divided among RU 16 and RU 3 when Z01A was sub-divided: 4 here of 16');
		expect(describeValueSplit(split('divided', { whole: null, part: null }))).toBe('divided among RU 16 and RU 3 when Z01A was sub-divided');
		expect(describeValueSplit(split('scaled', { whole: 0.001, part: 0.0006 }))).toBe('scaled for RU 16 and RU 3 when Z01A was sub-divided: 0.0006 here from 0.001');
		expect(describeValueSplit(split('divided', { pieces: [RU16, RU3, { type: 'RU', number: 17 }] }))).toBe('divided among RU 16, RU 3 and RU 17 when Z01A was sub-divided');
	});
});
