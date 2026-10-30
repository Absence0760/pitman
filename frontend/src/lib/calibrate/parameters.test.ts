import { readRunoff, syntheticSamiParameters, writeRunoff, type RunoffModule } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { syntheticBundle } from '#lib/network/synthetic.js';
import { fieldValue, formatValue, groundwaterKind, parameterFields, withValues } from './parameters.js';

const classic = syntheticBundle().modules.find((m) => m.kind === 'RU') as RunoffModule;
const sami: RunoffModule = { ...classic, groundwaterModel: 2, sami: syntheticSamiParameters(classic.pitman) };

describe('parameterFields', () => {
	it('gives a classic module the eleven L.003 parameters, each with a unit', () => {
		const fields = parameterFields(classic);
		expect(fields.map((f) => f.symbol)).toEqual(['POW', 'SL', 'ST', 'FT', 'GW', 'ZMIN', 'ZMAX', 'PI', 'TL', 'GL', 'R']);
		expect(fields.every((f) => f.path.startsWith('pitman.') && f.line.startsWith('L.003') && f.unit !== '')).toBe(true);
	});

	it('gives a Sami module the L.035 set and the Sami set, and leaves L.003 out', () => {
		const fields = parameterFields(sami);
		expect(fields.filter((f) => f.path.startsWith('sami.pitman.')).map((f) => f.line)[2]).toBe('L.035 v3');
		expect(fields.filter((f) => f.path.startsWith('pitman.'))).toEqual([]);
		expect(fields).toHaveLength(31);
	});

	it('says a Sami run ignores GW and GL', () => {
		const caution = parameterFields(sami).filter((f) => f.caution !== undefined).map((f) => f.symbol);
		expect(caution).toEqual(['GW', 'GL']);
	});

	it('offers nothing for Hughes, which cannot run', () => {
		const hughes: RunoffModule = { ...classic, groundwaterModel: 1 };
		expect(groundwaterKind(hughes)).toBe('hughes');
		expect(parameterFields(hughes)).toEqual([]);
	});
});

describe('values', () => {
	it('reads and writes the active set only', () => {
		const next = withValues(sami, { 'sami.pitman.ST': 222, 'sami.PPOW': 0.3 });
		expect(fieldValue(next, 'sami.pitman.ST')).toBe(222);
		expect(fieldValue(next, 'sami.PPOW')).toBe(0.3);
		expect(next.pitman).toEqual(sami.pitman);
		expect(fieldValue(withValues(classic, { 'pitman.ST': 222 }), 'pitman.ST')).toBe(222);
	});

	it('keeps the rest of the module, and does not change the original', () => {
		const next = withValues(sami, { 'sami.K2': 0.2 });
		expect(next.sPanMm).toBe(sami.sPanMm);
		expect(sami.sami?.K2).toBe(0.1);
	});

	it('formats a value as the file does, and in full when it holds more', () => {
		expect(formatValue({ decimals: 1 }, 3)).toBe('3.0');
		expect(formatValue({ decimals: 4 }, 0.005)).toBe('0.0050');
		expect(formatValue({ decimals: 1 }, 2.55)).toBe('2.55');
		expect(formatValue({ decimals: 1 }, NaN)).toBe('—');
	});
});

describe('the file holds what the screen shows', () => {
	it('every field round-trips through the writer at the file’s precision', () => {
		for (const field of parameterFields(sami)) {
			const value = field.rule === 'wholeFromOne' ? 3 : field.rule === 'fraction' ? 0.3 : field.decimals === 0 ? 123 : Number((1.25).toFixed(field.decimals));
			const next = withValues(sami, { [field.path]: value });
			const saved = readRunoff(writeRunoff(next), 'test');
			expect(fieldValue(saved, field.path), field.path).toBe(value);
		}
	});

	it('a value as wide as the field still writes', () => {
		for (const field of parameterFields(sami)) {
			const whole = field.width - (field.decimals > 0 ? field.decimals + 1 : 0);
			// Fives, not nines: the writer rounds through float32 (U-18), which turns 9.99999999 into 10.
			const widest = Number(`${'5'.repeat(whole)}${field.decimals > 0 ? `.${'5'.repeat(field.decimals)}` : ''}`);
			expect(() => writeRunoff(withValues(sami, { [field.path]: widest })), field.path).not.toThrow();
		}
	});
});
