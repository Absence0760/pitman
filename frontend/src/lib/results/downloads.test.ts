import { readAnswer } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { analyseTarget } from './analysis.js';
import { answerDownload, answerFileName, csvDownload } from './downloads.js';
import { bundle, flow, natural, presentDay } from './fixtures.js';
import { resultTargets, type ResultTarget } from './targets.js';

const targets = resultTargets(bundle, [presentDay, natural]).flatMap((g) => g.targets);
const byId = (id: string) => targets.find((t) => t.id === id) as ResultTarget;

describe('answer files', () => {
	it("use WRSM2000's names, with the mode appended when there are several runs", () => {
		expect(answerFileName('SY', { kind: 'route', number: 3 }, null)).toBe('SYRQ3.ANS');
		expect(answerFileName('SY', { kind: 'reservoir', number: 2 }, { kind: 'natural' })).toBe('SYRV2-natural.ANS');
		expect(answerFileName('SY', { kind: 'route', number: 3 }, { kind: 'presentDay', year: 2025 })).toBe('SYRQ3-present-2025.ANS');
	});

	it("write WRSM2000's layout and read back", () => {
		const series = presentDay.routeFlows[3]!;
		const d = answerDownload('SY', { kind: 'route', number: 3 }, series, presentDay.mode, false);
		expect(d.fileName).toBe('SYRQ3.ANS');
		expect(d.text.split('\r\n')).toHaveLength(3 + 2 + 1);
		const back = readAnswer(d.text, d.fileName);
		expect(back.kind).toBe('RQ');
		expect(back.rows.map((r) => r.year)).toEqual([2000, 2001, 2002]);
		expect(back.rows[0]?.months[1]).toBeCloseTo(3.01, 9);
		expect(answerDownload('SY', { kind: 'route', number: 3 }, series, natural.mode, true).fileName).toBe('SYRQ3-natural.ANS');
	});

	it('refuse a value too wide for the F8.2 columns', () => {
		expect(() => answerDownload('SY', { kind: 'route', number: 1 }, flow(2000, new Array(12).fill(1e6)), presentDay.mode, false)).toThrow(RangeError);
	});
});

describe('csvDownload', () => {
	it('lists every run and the observed flows month by month', () => {
		const d = csvDownload('SY', analyseTarget(byId('route-3'), [presentDay, natural]))!;
		expect(d.fileName).toBe('SYRQ3.csv');
		const lines = d.text.split('\r\n');
		expect(lines[0]).toBe(
			'hydrological_year,month,calendar_year,Present day (2025) (million m³/month),Natural (million m³/month),Observed (million m³/month),observed_incomplete'
		);
		expect(lines).toHaveLength(1 + 36 + 1);
		expect(lines[1]).toBe('2000,Oct,2000,3,4.5,3,');
		expect(lines[4]?.startsWith('2000,Jan,2001,')).toBe(true);
		expect(lines[1 + 12 + 2]?.endsWith(',,')).toBe(true);
		expect(lines[1 + 24 + 4]?.endsWith(',5,yes')).toBe(true);
		expect(lines[37]).toBe('');
	});

	it('has no observed columns without a gauge, storage units for a reservoir, nothing without data', () => {
		const d = csvDownload('SY', analyseTarget(byId('reservoir-2'), [presentDay]))!;
		expect(d.fileName).toBe('SYRV2.csv');
		expect(d.text.split('\r\n')[0]).toBe('hydrological_year,month,calendar_year,Present day (2025) (million m³)');
		expect(csvDownload('SY', analyseTarget(byId('route-1'), [{ ...presentDay, routeFlows: {} }]))).toBeNull();
	});
});
