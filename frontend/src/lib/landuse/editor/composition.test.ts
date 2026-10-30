import { applyCompositionEdits, applyTableEdits, readBundle, writeBundle, type NetworkBundle, type RunoffModule } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { compositionChangeLine, fillCompositionNotes, formatValue, resetValue, reviewComposition, toCompositionEdits, type CompositionDraft, type CompositionRow, type CompositionView } from './composition.js';
import { landUseBundle, runoff, withRunoff } from './fixtures.test-helper.js';
import { changeLine, fillNotes, refusedRows, reviewModule, toEdits } from './review.js';

const bundle = landUseBundle();
const free = runoff(bundle, 1);
const child = runoff(bundle, 3);
const DATE = '2026-10-30T08:00:00.000Z';
const PINE = 'afforestation.species.pine.percent';
const EUC = 'afforestation.species.eucalyptus.percent';
const ROTATION = 'afforestation.species.pine.rotationYears';
const OPTIMAL = 'afforestation.optimalPercent';
const TALL = 'alienVegetation.composition.tallTrees.percent';
const AGE = 'alienVegetation.composition.tallShrubs.ageYears';

const view = (b: NetworkBundle, m: RunoffModule, table: CompositionView['table'], draft: CompositionDraft = {}) => reviewComposition(b, m, draft, 'SYRU1.DAT').views.find((v) => v.table === table)!;
const rowOf = (v: CompositionView, field: string): CompositionRow => [...v.shares, ...v.others].find((r) => r.field.field === field)!;
const typed = (text: string, note = '') => ({ text, note });

describe('formatValue', () => {
	it('shows the file’s precision, or all a file held beyond it', () => {
		const v = view(bundle, free, 'afforestation');
		expect(formatValue(rowOf(v, PINE).field, 60)).toBe('60.00');
		expect(formatValue(rowOf(v, ROTATION).field, 20)).toBe('20');
		expect(formatValue(rowOf(v, PINE).field, 33.333)).toBe('33.333');
	});
});

describe('reviewComposition', () => {
	it('shows every value of the block as the file has it, shares apart, with their sum', () => {
		const v = view(bundle, free, 'afforestation');
		expect(v.shares.map((r) => [r.field.label, r.text, r.state, r.file])).toEqual([
			['Pine share', '60.00', 'same', 60],
			['Eucalyptus share', '40.00', 'same', 40],
			['Wattle share', '0.00', 'same', 0]
		]);
		expect(v.others.map((r) => r.field.label)).toEqual(['Pine rotation', 'Eucalyptus rotation', 'Wattle rotation', 'Optimal growth area', 'Required reduction of MAR', 'Required reduction of low flow']);
		expect(v.sum).toEqual({ text: 'Sum: 100.00 %', ok: true });
		expect(v.origin).toBe('From SYRU1.DAT, L.009–L.010');
	});

	it('holds the alien classes, ages, optimal area and riparian share', () => {
		const v = view(bundle, free, 'alienVegetation');
		expect(v.shares.map((r) => r.text)).toEqual(['50.00', '30.00', '20.00']);
		expect(v.others.map((r) => [r.field.label, r.text])).toEqual([
			['Tall trees age', '15.00'],
			['Medium trees age', '10.00'],
			['Tall shrubs age', '8.00'],
			['Optimal area', '70.00'],
			['Riparian share', '20.00']
		]);
	});

	it('marks an edit, keeping the file’s value beside it and asking for a source', () => {
		const r = rowOf(view(bundle, free, 'afforestation', { [ROTATION]: typed('25') }), ROTATION);
		expect(r).toMatchObject({ state: 'edited', current: 20, file: 20, target: 25, changed: true, needsNote: true, error: null });
	});

	it('takes a decimal comma, and treats a value typed back as no change', () => {
		expect(rowOf(view(bundle, free, 'afforestation', { [PINE]: typed('55,5') }), PINE).target).toBe(55.5);
		expect(rowOf(view(bundle, free, 'afforestation', { [ROTATION]: typed('20') }), ROTATION)).toMatchObject({ state: 'same', changed: false, needsNote: false });
	});

	it('refuses what the file can’t hold, in the engine’s words, and keeps the value in the preview', () => {
		const r = rowOf(view(bundle, free, 'afforestation', { [PINE]: typed('33.333') }), PINE);
		expect(r).toMatchObject({ state: 'edited', target: 60, changed: false });
		expect(r.error).toContain('Use 33.33 or 33.34');
		expect(rowOf(view(bundle, free, 'afforestation', { [PINE]: typed('') }), PINE).error).toBe('Enter a value for pine share, or reset it.');
		expect(rowOf(view(bundle, free, 'afforestation', { [PINE]: typed('lots') }), PINE).error).toBe('Pine share must be a number.');
	});

	it('shows the sum as typed and stops Apply when edited shares miss 100', () => {
		const v = view(bundle, free, 'afforestation', { [PINE]: typed('55') });
		expect(v.sum).toEqual({ text: 'Sum: 95.00 %, 5.00 short of 100', ok: false });
		expect(v.sumProblem).toBe('The three genus shares (L.009) must add up to 100 %. They come to 95.00 %, 5.00 short of 100.');
		const fixed = view(bundle, free, 'afforestation', { [PINE]: typed('55'), [EUC]: typed('45') });
		expect(fixed).toMatchObject({ sum: { text: 'Sum: 100.00 %', ok: true }, sumProblem: null });
	});

	it('says which box to fix before it judges the sum', () => {
		const v = view(bundle, free, 'afforestation', { [PINE]: typed('nope') });
		expect(v.sum).toEqual({ text: 'Sum: fix the boxes above', ok: false });
		expect(v.sumProblem).toBeNull();
	});

	it('shows, but doesn’t blame the user for, a file whose shares miss 100', () => {
		const off = withRunoff(bundle, 1, (m) => ({ ...m, afforestation: { ...m.afforestation, species: { ...m.afforestation.species!, pine: { percent: 50, rotationYears: 20 } } } }));
		const v = view(off, runoff(off, 1), 'afforestation', { [ROTATION]: typed('25') });
		expect(v.sum).toEqual({ text: 'Sum: 90.00 %, 10.00 short of 100', ok: false });
		expect(v.sumProblem).toBeNull();
	});

	it('has no block where the file has no lines for it', () => {
		const empty = runoff(bundle, 2);
		expect(reviewComposition(bundle, empty, {}, 'x').views).toEqual([]);
		const oldFile = withRunoff(bundle, 1, (m) => ({ ...m, fileVersion: 0 }));
		expect(reviewComposition(oldFile, runoff(oldFile, 1), {}, 'x').views.map((v) => v.table)).toEqual([]);
	});

	it('says a sub-division’s piece copied its values', () => {
		const split: NetworkBundle = { ...bundle, sidecar: { schema: 'pitman-sidecar', schemaVersion: 1, subdivisions: { Z01A: { module: { type: 'RU', number: 9 }, pieces: [{ number: 1 }], shares: { afforestation: 'area', alien: 'area' } } } as never } };
		expect(view(split, free, 'afforestation').origin).toBe('Copied from RU 9’s L.009–L.010 to each piece in the Z01A sub-division');
	});
});

describe('what a change does', () => {
	it('shows the targets a child is calibrated to, before and after, at its parent’s MAP', () => {
		const same = view(bundle, child, 'afforestation');
		const parentMap = runoff(bundle, 2).mapMm;
		expect(same.targets).toContain('Targets a run calibrates this child to: MAR ');
		expect(same.targets).toContain(`(Smoothed Gush/Pitman, at RU 2’s MAP of ${parentMap} mm)`);
		expect(same.targets).not.toContain('→');
		const moved = view(bundle, child, 'afforestation', { [PINE]: typed('10'), [EUC]: typed('90') });
		expect(moved.targets).toMatch(/MAR [\d.]+ % → [\d.]+ %, low flow [\d.]+ % → [\d.]+ %/);
	});

	it('won’t show targets for shares that don’t add up', () => {
		expect(view(bundle, child, 'afforestation', { [PINE]: typed('10') }).targets).toBe('Targets a run calibrates this child to: put the shares right to see them.');
	});

	it('shows no afforestation targets for a free module, which takes no reduction yet', () => {
		expect(view(bundle, free, 'afforestation').targets).toBeNull();
	});

	it('shows a free module’s alien reduction, and none when the algorithm is None', () => {
		expect(view(bundle, free, 'alienVegetation').targets).toContain('Reductions a run takes: MAR ');
		const off = withRunoff(bundle, 1, (m) => ({ ...m, alienVegetation: { ...m.alienVegetation!, algorithm: 0 as const } }));
		expect(view(off, runoff(off, 1), 'alienVegetation').targets).toBeNull();
	});

	it('says what the algorithm reads, and that the algorithm itself stays in WRSM2000', () => {
		const notes = view(bundle, child, 'afforestation').notes;
		expect(notes[0]).toContain('calibrates it to them every time');
		expect(notes[0]).toContain('A fit of RU 2 to a gauge was made with the old targets');
		expect(notes[1]).toContain('Smoothed Gush reads the genus shares only');
		expect(notes[2]).toBe('The algorithm (L.006) isn’t edited here: it decides how a run treats this area and how the child is calibrated, so change it in WRSM2000.');
	});

	it('warns on a young stand and an untested optimal area, on a child only', () => {
		const alienChild = withRunoff(bundle, 3, (m) => ({ ...m, afforestation: { ...m.afforestation, areaKm2: [] }, alienVegetation: runoff(bundle, 1).alienVegetation! }));
		const m = runoff(alienChild, 3);
		expect(rowOf(view(alienChild, m, 'alienVegetation', { [AGE]: typed('6') }), AGE).hint).toContain('SFR iteration may not close (TT 691 p.211)');
		expect(rowOf(view(alienChild, m, 'alienVegetation', { 'alienVegetation.optimalPercent': typed('60') }), 'alienVegetation.optimalPercent').hint).toContain('(R6-V1)');
		expect(rowOf(view(bundle, free, 'alienVegetation', { [AGE]: typed('6') }), AGE).hint).toBeNull();
	});
});

describe('values that stay read-only', () => {
	const csir = withRunoff(bundle, 3, (m) => ({ ...m, afforestation: { ...m.afforestation, algorithm: 1 as const } }));
	const m = runoff(csir, 3);

	it('keeps rotations and optimal growth on a CSIR child in view, without a box, and says why once', () => {
		const v = view(csir, m, 'afforestation');
		expect(rowOf(v, ROTATION)).toMatchObject({ locked: true, text: '20' });
		expect(rowOf(v, OPTIMAL).locked).toBe(true);
		expect(rowOf(v, PINE).locked).toBe(false);
		expect(v.locks.filter((l) => l.includes('Read-only on a CSIR child'))).toHaveLength(1);
		expect(v.locks[0]).toContain('when the SFR calibration doesn’t close');
		expect(v.targets).toContain('(Smoothed Gush, standing in for CSIR, at RU 2’s MAP');
	});

	it('ignores a draft for a locked value', () => {
		expect(rowOf(view(csir, m, 'afforestation', { [ROTATION]: typed('5') }), ROTATION)).toMatchObject({ changed: false, text: '20' });
	});

	it('opens the required reductions only under User-defined', () => {
		const mar = 'afforestation.userDefinedReduction.marPercent';
		expect(rowOf(view(bundle, free, 'afforestation'), mar).locked).toBe(true);
		expect(view(bundle, free, 'afforestation').locks).toEqual([]);
		expect(view(bundle, free, 'afforestation').notes.at(-1)).toContain('only the User-defined algorithm reads this');
		const own = withRunoff(bundle, 3, (c) => ({ ...c, afforestation: { ...c.afforestation, algorithm: 4 as const } }));
		const row = rowOf(view(own, runoff(own, 3), 'afforestation', { [mar]: typed('15') }), mar);
		expect(row).toMatchObject({ locked: false, current: null, target: 15, changed: true });
	});
});

describe('reset', () => {
	it('drops the draft of a value the working copy still holds', () => {
		const draft = { [ROTATION]: typed('25') };
		expect(resetValue(draft, rowOf(view(bundle, free, 'afforestation', draft), ROTATION))).toEqual({});
	});

	it('goes back to the file’s value after an apply, with no source needed', () => {
		const once = applyCompositionEdits(bundle, [{ module: { type: 'RU', number: 1 }, field: ROTATION, value: 25, source: { kind: 'manual', note: 'Survey', date: DATE } }]);
		const m = runoff(once, 1);
		const row = rowOf(view(once, m, 'afforestation'), ROTATION);
		expect(row).toMatchObject({ current: 25, file: 20, applied: 'Applied 2026-10-30: Survey' });
		const draft = resetValue({}, row);
		expect(draft).toEqual({ [ROTATION]: { text: '20', note: '' } });
		const review = reviewModule(once, m, { composition: draft });
		expect(review.compositionChanges[0]).toMatchObject({ backToFile: true, to: 20 });
		expect(review.missingNotes).toBe(0);
		const back = applyCompositionEdits(once, toCompositionEdits(m, review.compositionChanges, DATE));
		expect(back.sidecar?.values?.at(-1)?.source).toMatchObject({ kind: 'networkFile', note: 'Land use: 25 → 20; Back to the network file’s value' });
	});
});

describe('in the module’s review', () => {
	it('counts composition values with the rows, for Apply and the notes', () => {
		const review = reviewModule(bundle, free, { afforestation: { 2004: { text: '11', note: '' } }, composition: { [ROTATION]: typed('25') } });
		expect(review.pending).toBe(2);
		expect(review.missingNotes).toBe(2);
		expect(review.valid).toBe(true);
		expect(review.next.afforestation.species?.pine.rotationYears).toBe(25);
		expect(compositionChangeLine(review.compositionChanges[0]!)).toBe('Afforestation, pine rotation: 20 years → 25 years');
	});

	it('stops Apply on a sum or a refused value, and names them', () => {
		const sum = reviewModule(bundle, free, { composition: { [TALL]: typed('60') } });
		expect(sum.valid).toBe(false);
		expect(sum.errors[0]).toContain('The three class shares (L.014, TT 689 p.128) must add up to 100 %');
		const refused = reviewModule(bundle, free, { composition: { [PINE]: typed('150') } });
		expect(refused.valid).toBe(false);
		expect(refusedRows(refused)).toEqual(['Afforestation, pine share: A percentage runs from 0 to 100.']);
	});

	it('fills empty notes across rows and values, and leaves a typed one', () => {
		const draft = { afforestation: { 2004: { text: '11', note: '' } }, composition: { [ROTATION]: typed('25'), 'afforestation.species.eucalyptus.rotationYears': typed('12', 'Own note') } };
		const filled = fillNotes(draft, reviewModule(bundle, free, draft), 'Forestry records 2024');
		expect(filled.afforestation?.[2004]?.note).toBe('Forestry records 2024');
		expect(filled.composition?.[ROTATION]?.note).toBe('Forestry records 2024');
		expect(filled.composition?.['afforestation.species.eucalyptus.rotationYears']?.note).toBe('Own note');
		expect(fillCompositionNotes({}, [], 'x')).toEqual({});
	});

	it('says when saving would round a value the file held with more decimals', () => {
		const loose = withRunoff(bundle, 1, (m) => ({ ...m, afforestation: { ...m.afforestation, optimalPercent: 33.333 } }));
		const review = reviewModule(loose, runoff(loose, 1), { composition: { [ROTATION]: typed('25') } });
		expect(review.saved.rounded).toContain('optimal growth area');
	});

	it('sets the split of a table opened in the same Apply', () => {
		const empty = withRunoff(bundle, 1, (m) => ({ ...m, afforestation: { algorithm: 2, algorithmInFile: true, areaKm2: [] } }));
		const m = runoff(empty, 1);
		const draft = { afforestation: { 2025: { text: '3.5', note: 'Register' } }, composition: { [PINE]: typed('100', 'Register') } };
		const review = reviewModule(empty, m, draft);
		expect(review.composition.map((v) => v.table)).toContain('afforestation');
		expect(review.valid).toBe(true);
		const tabled = applyTableEdits(empty, toEdits(m, review.changes, DATE));
		const next = applyCompositionEdits(tabled, toCompositionEdits(m, review.compositionChanges, DATE));
		const read = readBundle(writeBundle(next));
		if (!read.ok) throw new Error(JSON.stringify(read.errors));
		expect(runoff(read.bundle, 1).afforestation.species?.pine.percent).toBe(100);
		expect(review.changes.map(changeLine)).toEqual(['Afforestation 2025: none → 3.5 km²']);
	});
});
