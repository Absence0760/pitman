import { describe, expect, it } from 'vitest';
import { WORKED_CHIRPS, extensionOf, workedFit } from './fixtures.test-helper.js';
import { chirpsFacts, extensionLabel, fitFacts, previousExtension } from './provenance.js';

describe('provenance (rule 8)', () => {
	it('names the product, revision, final day, cells, weight removed, area and fetch date', () => {
		const facts = Object.fromEntries(chirpsFacts({ ...WORKED_CHIRPS, source: 's3', weightRemovedPct: 12.34 }, '2026-10-29').map((f) => [f.label, f.value]));
		expect(facts).toMatchObject({
			Product: 'CHIRPS v3 rnl (final)',
			Copy: 'IC-WBT rain data copy, revision 17',
			'Final data through': '1987-12-31',
			Months: '1981-01 to 1987-12 (84 months)',
			Area: '812.4 km²',
			Cells: '41 CHIRPS cells (0.05°), area-weighted',
			'Weight removed (sea or no data)': '12.3 %',
			Fetched: '2026-10-29'
		});
		expect(chirpsFacts(WORKED_CHIRPS, '2026-10-29').find((f) => f.label === 'Copy')?.value).toMatch(/^Local synthetic copy/);
	});

	it('gives the CHIRPS MAP and the overlap, saying whether the user narrowed it', () => {
		expect(fitFacts(workedFit()).map((f) => f.value)).toEqual([
			'452.8 mm (mean of the complete hydrological years 1981/82 to 1985/86)',
			'1981/82 to 1984/85, 4 years (the whole overlap)'
		]);
		expect(fitFacts(workedFit({ overlap: { startYear: 1982, endYear: 1982, window: 'user' } }))[1]?.value).toBe('1982/83 to 1982/83, 1 year (narrowed by you)');
	});

	it('describes an earlier extension', () => {
		const ext = extensionOf('SYA.RAN', 1999, 2004);
		expect(extensionLabel(ext)).toBe('Extended to 2004/05 (CHIRPS v3 rnl (final), fetched 2026-10-28)');
		expect(previousExtension(ext)).toMatch(/2000\/01 to 2004\/05 .* 1 factor edited\)\. The original record ends 1999\/00/);
	});
});
