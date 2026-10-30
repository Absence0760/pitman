import type { Sidecar } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { landUseBundle, runoff, withRunoff } from './fixtures.test-helper.js';
import { coverageSummary, moduleChoices, moduleLabel, moduleRole, pieceOrigin, tableOffer } from './offers.js';

const bundle = landUseBundle();
const offer = (number: number, table: Parameters<typeof tableOffer>[2], b = bundle) => tableOffer(b, runoff(b, number), table, `SYRU${number}.DAT`);

describe('moduleChoices and coverageSummary', () => {
	it('lists every runoff module in .NET order, saying how far its tables reach', () => {
		const choices = moduleChoices(bundle);
		expect(choices.map((c) => c.number)).toEqual([1, 2, 3]);
		expect(choices[0]?.label).toBe(`${moduleLabel(runoff(bundle, 1))} (afforestation to 2004, alien vegetation to 1995, paved area to 2000)`);
		expect(choices[1]?.label).toBe(moduleLabel(runoff(bundle, 2)));
	});

	it('says what there is to do across the network', () => {
		expect(coverageSummary(moduleChoices(bundle))).toBe('2 of the 3 runoff modules have land-use tables; 2 stop before 2025.');
		expect(coverageSummary([{ number: 1, label: 'a', lastYears: [2025] }])).toBe('1 of the 1 runoff modules have land-use tables; all reach 2025.');
		expect(coverageSummary([{ number: 1, label: 'a', lastYears: [] }])).toContain('None of the 1');
	});
});

describe('moduleRole', () => {
	it('tells free, parent and child apart', () => {
		expect(moduleRole(bundle, runoff(bundle, 1)).kind).toBe('free');
		expect(moduleRole(bundle, runoff(bundle, 2))).toMatchObject({ kind: 'parent', children: [{ number: 3 }] });
		expect(moduleRole(bundle, runoff(bundle, 3))).toMatchObject({ kind: 'child', parent: { number: 2 } });
	});
});

describe('tableOffer', () => {
	it('opens all three tables on a free module, with the file’s lines as the source', () => {
		for (const table of ['afforestation', 'alienVegetation', 'paved'] as const) expect(offer(1, table)).toMatchObject({ open: true, shown: true, why: null });
		expect(offer(1, 'afforestation').origin).toBe('From SYRU1.DAT, L.007–L.008');
		expect(offer(1, 'paved').origin).toBe('From SYRU1.DAT, L.017–L.018, as a fraction of the catchment');
	});

	it('states each table’s unit', () => {
		expect(offer(1, 'afforestation').valueLabel).toBe('Afforested area, km²');
		expect(offer(1, 'alienVegetation').valueLabel).toBe('Alien vegetation area, km²');
		expect(offer(1, 'paved').valueLabel).toBe('Paved fraction (0–1)');
	});

	it('shows the file’s other lines for the table', () => {
		expect(offer(1, 'afforestation').facts).toContain('Smoothed Gush/Pitman (L.006); pine 60 %, 20-year rotation');
		expect(offer(1, 'alienVegetation').facts).toContain('Algorithm: CSIR (L.011); tall trees 50 %, 15 years old');
		expect(offer(1, 'paved').facts).toBeNull();
	});

	it('edits a child’s own table, which a run reads as its active area (R7-T5)', () => {
		expect(offer(3, 'afforestation')).toMatchObject({ open: true, shown: true });
	});

	it('gives a parent paved area only, and says where the rest goes (TT 689 p.140)', () => {
		expect(offer(2, 'paved').open).toBe(true);
		expect(offer(2, 'afforestation')).toMatchObject({ open: false, shown: false });
		expect(offer(2, 'afforestation').why).toContain('children’s tables');
	});

	it('gives a child no paved area and keeps it to one kind, and says where to go', () => {
		expect(offer(3, 'paved')).toMatchObject({ open: false, shown: false });
		expect(offer(3, 'paved').why).toContain('RU 2');
		expect(offer(3, 'alienVegetation')).toMatchObject({ open: false, shown: false });
		expect(offer(3, 'alienVegetation').why).toContain('child of its own under RU 2');
	});

	it('an alien child is closed to afforestation the same way', () => {
		const alien = withRunoff(bundle, 3, (m) => ({
			...m,
			afforestation: { ...m.afforestation, areaKm2: [] },
			alienVegetation: { algorithm: 1, riparianArea: 0, areaKm2: [{ year: 2000, value: 1 }] }
		}));
		expect(offer(3, 'afforestation', alien)).toMatchObject({ open: false, shown: false });
		expect(offer(3, 'alienVegetation', alien).open).toBe(true);
	});

	it('keeps forbidden rows in view, read-only, with what a run does', () => {
		const paved = withRunoff(bundle, 3, (m) => ({ ...m, paved: { fraction: [{ year: 2000, value: 0.1 }] } }));
		const seen = offer(3, 'paved', paved);
		expect(seen).toMatchObject({ open: false, shown: true });
		expect(seen.notes[0]).toContain('A run ignores these rows');
		const parent = withRunoff(bundle, 2, (m) => ({ ...m, afforestation: { ...m.afforestation, areaKm2: [{ year: 2000, value: 1 }] } }));
		expect(offer(2, 'afforestation', parent).notes[0]).toContain('doesn’t allow this on a parent');
	});

	it('says when a run takes nothing from the table', () => {
		expect(offer(1, 'afforestation').notes[0]).toContain('no flow reduction from afforestation in a free module');
		expect(offer(3, 'afforestation').notes).toEqual([]);
		const off = withRunoff(bundle, 1, (m) => ({ ...m, alienVegetation: { ...m.alienVegetation!, algorithm: 0 } }));
		expect(offer(1, 'alienVegetation', off).notes[0]).toContain('algorithm is None');
	});

	it('warns that a first row brings zeros for the lines the file lacks', () => {
		expect(offer(2, 'paved').notes).toEqual([]);
		const empty = withRunoff(bundle, 1, (m) => ({ ...m, afforestation: { algorithm: 0, algorithmInFile: true, areaKm2: [] }, alienVegetation: { algorithm: 0, riparianArea: 0, areaKm2: [] } }));
		expect(offer(1, 'afforestation', empty).notes[0]).toContain('0 % of each genus');
		expect(offer(1, 'alienVegetation', empty).notes[0]).toContain('0 % of each class');
	});

	it('closes a table whose years can’t be told apart, and names the way out', () => {
		const twice = withRunoff(bundle, 1, (m) => ({ ...m, paved: { fraction: [{ year: 2000, value: 0.1 }, { year: 2000, value: 0.2 }] } }));
		const seen = offer(1, 'paved', twice);
		expect(seen).toMatchObject({ open: false, shown: true });
		expect(seen.why).toBe('The file lists 2000 twice. This screen can’t tell which row an edit means, so correct the module’s file (SYRU1.DAT, L.017–L.018) and load it again.');
	});

	it('has no alien vegetation table on a version 0 file', () => {
		const old = withRunoff(bundle, 1, (m) => ({ ...m, fileVersion: 0, alienVegetation: { algorithm: 0, riparianArea: 0, areaKm2: [] } }));
		expect(offer(1, 'alienVegetation', old)).toMatchObject({ open: false, shown: false });
		expect(offer(1, 'alienVegetation', old).why).toContain('version 0');
	});
});

describe('a sub-divided network', () => {
	const entry = {
		module: { type: 'RU', number: 1, areaKm2: 100, mapMm: 600 },
		pieces: [{ role: 'outlet', number: 1 }, { role: 'tributary', number: 7 }],
		children: [{ number: 3, areaKm2: 10, mapMm: 600, pieces: [3, 9] }],
		shares: { afforestation: 'location', alien: 'area', dams: 'area' }
	};
	const sidecar = { schema: 'pitman-sidecar', schemaVersion: 1, subdivisions: { A10B: entry } } as unknown as Sidecar;

	it('finds a piece, and a child split with it', () => {
		expect(pieceOrigin(sidecar, 7)).toMatchObject({ quaternary: 'A10B', original: 1 });
		expect(pieceOrigin(sidecar, 9)).toMatchObject({ quaternary: 'A10B', original: 3 });
		expect(pieceOrigin(sidecar, 2)).toBeUndefined();
		expect(pieceOrigin(undefined, 7)).toBeUndefined();
	});

	it('credits the split as the rows’ source; the module is otherwise like any other', () => {
		const split = { ...bundle, sidecar };
		expect(offer(1, 'afforestation', split)).toMatchObject({ open: true, origin: 'From RU 1’s table, split by location in the A10B sub-division' });
		expect(offer(1, 'alienVegetation', split).origin).toContain('split by area');
		expect(offer(1, 'paved', split).origin).toContain('copied as a fraction');
	});
});
