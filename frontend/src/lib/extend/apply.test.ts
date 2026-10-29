import { describe, expect, it } from 'vitest';
import { openNetwork } from '#lib/network/open.js';
import { syntheticNetworkFiles } from '#lib/network/synthetic.js';
import { writeBundle, type LoadedBundle } from '#lib/network/engine.js';
import { MAX_RUN_YEARS, isoDate, runPeriodOffer, withEndYear, withExtension } from './apply.js';
import { originalSeries } from './files.js';
import { WORKED_CHIRPS, extensionOf, fakeEngine, workedFit } from './fixtures.test-helper.js';

function loaded(options: Parameters<typeof syntheticNetworkFiles>[0] = {}): LoadedBundle {
	const outcome = openNetwork(syntheticNetworkFiles(options));
	if (outcome.kind !== 'loaded') throw new Error('synthetic network did not load');
	return outcome.bundle;
}

/** A fit that appends 2000–2004 to a 1990–1999 file. */
const fit = workedFit({
	overlap: { startYear: 1990, endYear: 1999, window: 'default' },
	chirpsPct: Array.from({ length: 15 }, (_, i) => ({ year: 1990 + i, months: Array(12).fill(8.5) as never })),
	appendable: { firstYear: 2000, lastYear: 2004 },
	stoppedAt: null
});

function extended(bundle: LoadedBundle, key = 'SYA.RAN') {
	const factors = fit.factors.map((f) => f.computed) as never;
	return fakeEngine(fit).apply(bundle.rainfall[key]!, WORKED_CHIRPS, fit, factors, { file: key, quaternaries: ['Z01A'], accessed: '2026-10-29' });
}

describe('withExtension', () => {
	it('replaces the series and records the sidecar entry, leaving everything else', () => {
		const bundle = loaded();
		const result = extended(bundle);
		const next = withExtension(bundle, 'SYA.RAN', result);
		expect(next.rainfall['SYA.RAN']).toBe(result.series);
		expect(next.rainfall['SYB.RAN']).toBe(bundle.rainfall['SYB.RAN']);
		expect(next.sidecar).toEqual({ schema: 'pitman-sidecar', schemaVersion: 1, rainfallExtensions: { 'SYA.RAN': result.extension } });
		expect(next.files).toBe(bundle.files);
		expect(bundle.sidecar).toBeUndefined(); // the input is not changed
	});

	it('keeps other files’ extensions and replaces this file’s', () => {
		const bundle = { ...loaded(), sidecar: { schema: 'pitman-sidecar' as const, schemaVersion: 1 as const, writtenBy: 'Pitman 0.0.1', rainfallExtensions: { 'SYB.RAN': extensionOf('SYB.RAN', 1999, 2004), 'SYA.RAN': extensionOf('SYA.RAN', 1999, 2001) } } };
		const next = withExtension(bundle, 'SYA.RAN', extended(bundle));
		expect(Object.keys(next.sidecar?.rainfallExtensions ?? {}).sort()).toEqual(['SYA.RAN', 'SYB.RAN']);
		expect(next.sidecar?.rainfallExtensions?.['SYA.RAN']?.appendedYears).toEqual({ first: 2000, last: 2004 });
		expect(next.sidecar?.writtenBy).toBe('Pitman 0.0.1');
	});

	it('survives the working copy: written, read back, the appended rows and the sidecar are there', () => {
		const bundle = loaded();
		const next = withEndYear(withExtension(bundle, 'SYA.RAN', extended(bundle)), 2004);
		const back = openNetwork(writeBundle(next));
		if (back.kind !== 'loaded') throw new Error(back.kind === 'invalid' ? back.errors.map((e) => e.message).join('; ') : 'choose');
		expect(back.bundle.rainfall['SYA.RAN']?.rows.map((r) => r.year).at(-1)).toBe(2004);
		expect(back.bundle.rainfall['SYA.RAN']?.rows.slice(0, 10)).toEqual(bundle.rainfall['SYA.RAN']?.rows);
		expect(back.bundle.sidecar?.rainfallExtensions?.['SYA.RAN']?.originalEndYear).toBe(1999);
		expect(back.bundle.network.endYear).toBe(2004);
		// Extending again starts from the original record.
		const entry = back.bundle.sidecar?.rainfallExtensions?.['SYA.RAN'];
		expect(originalSeries(back.bundle.rainfall['SYA.RAN']!, entry!.originalEndYear).rows).toHaveLength(10);
	});
});

describe('runPeriodOffer', () => {
	it('offers nothing until every rainfall file in use reaches further', () => {
		const bundle = loaded();
		const one = withExtension(bundle, 'SYA.RAN', extended(bundle));
		const offer = runPeriodOffer(one);
		expect(offer.canExtend).toBe(false);
		expect(offer.limitedBy).toEqual(['syb.RAN']);
		expect(offer.reason).toMatch(/limited by syb\.RAN/);
	});

	it('offers the last year every file in use reaches', () => {
		const bundle = loaded();
		let both = withExtension(bundle, 'SYA.RAN', extended(bundle));
		both = withExtension(both, 'SYB.RAN', extended(both, 'SYB.RAN'));
		expect(runPeriodOffer(both)).toEqual({ currentEndYear: 1999, reachableEndYear: 2004, limitedBy: ['SYA.RAN', 'syb.RAN'], canExtend: true, reason: '' });
		expect(runPeriodOffer(withEndYear(both, 2004)).canExtend).toBe(false);
	});

	it('stops at WRSM2000’s 150-year limit', () => {
		const bundle = loaded({ startYear: 1852, years: 148 });
		let both = withExtension(bundle, 'SYA.RAN', extended(bundle));
		both = withExtension(both, 'SYB.RAN', extended(both, 'SYB.RAN'));
		const offer = runPeriodOffer(both);
		expect(offer.reachableEndYear).toBe(1852 + MAX_RUN_YEARS - 1);
		expect(offer.canExtend).toBe(true);
	});
});

describe('isoDate', () => {
	it('is the local calendar date', () => {
		expect(isoDate(new Date(2026, 9, 29, 23, 30))).toBe('2026-10-29');
		expect(isoDate(new Date(2026, 0, 5, 0, 5))).toBe('2026-01-05');
	});
});
