import { describe, expect, it } from 'vitest';
import { formatF, formatI, readFortranReal } from './series.js';

const at = { file: 'x', line: 1, column: 1, field: 'v' };

describe('readFortranReal (Fw.d input)', () => {
	it('lets an explicit point win', () => {
		expect(readFortranReal('  1.234', 2, at)).toBe(1.234);
		expect(readFortranReal('    .06', 0, at)).toBe(0.06);
		expect(readFortranReal('    12.', 2, at)).toBe(12);
	});

	it('takes the last d digits as decimals without a point', () => {
		expect(readFortranReal('    123', 2, at)).toBe(1.23);
		expect(readFortranReal('    123', 0, at)).toBe(123);
	});

	it('reads blanks as nothing and an all-blank field as 0', () => {
		expect(readFortranReal('       ', 0, at)).toBe(0);
		expect(readFortranReal(' 1 5.0 ', 0, at)).toBe(15);
	});

	it('reads signs and exponents', () => {
		expect(readFortranReal(' -99.99', 0, at)).toBe(-99.99);
		expect(readFortranReal(' 1.5E-2', 0, at)).toBe(0.015);
		expect(readFortranReal('  1.5D2', 0, at)).toBe(150);
	});

	it('names the field on junk', () => {
		expect(() => readFortranReal('  abc  ', 0, at)).toThrow('x:1:1 (v): expected a number');
		expect(() => readFortranReal('    -  ', 0, at)).toThrow(/expected a number/);
	});
});

describe('formatF / formatI', () => {
	it('right-justifies with a leading zero', () => {
		expect(formatF(0.8, 6, 2, 'v')).toBe('  0.80');
		expect(formatF(139, 7, 2, 'v')).toBe(' 139.00');
	});

	it('fails on overflow and non-finite values', () => {
		expect(() => formatF(1e6, 7, 2, 'v')).toThrow('v: 1000000 does not fit F7.2');
		expect(() => formatF(Number.NaN, 7, 2, 'v')).toThrow(/finite/);
		expect(() => formatI(12345, 4, 'n')).toThrow('n: 12345 does not fit I4');
		expect(() => formatI(1.5, 4, 'n')).toThrow(/integer/);
	});
});
