import { samiAquiferInit, syntheticSamiParameters, validatePitmanParameters, type RunoffModule } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { syntheticBundle } from '#lib/network/synthetic.js';
import { fieldValue, parameterFields, withValues } from './parameters.js';
import { checkDrafts, parseNumber } from './validate.js';

const classic = syntheticBundle().modules.find((m) => m.kind === 'RU') as RunoffModule;
const sami: RunoffModule = { ...classic, groundwaterModel: 2, sami: syntheticSamiParameters(classic.pitman) };
const classicFields = parameterFields(classic);
const samiFields = parameterFields(sami);

const message = (drafts: Record<string, string>, path: string, module = classic) => checkDrafts(module, parameterFields(module), drafts).messages[path];

describe('parseNumber', () => {
	it('reads numbers, a decimal comma and negatives', () => {
		expect(parseNumber(' 2.5 ')).toBe(2.5);
		expect(parseNumber('2,5')).toBe(2.5);
		expect(parseNumber('-3')).toBe(-3);
	});

	it('refuses what is not a number', () => {
		expect(parseNumber('')).toBeNull();
		expect(parseNumber('abc')).toBeNull();
		expect(parseNumber('Infinity')).toBeNull();
	});
});

describe('checkDrafts', () => {
	it('with nothing typed gives the module’s values and no message', () => {
		const check = checkDrafts(classic, classicFields, {});
		expect(check.valid).toBe(true);
		expect(check.messages).toEqual({});
		expect(check.values['pitman.ST']).toBe(classic.pitman.ST);
	});

	it('asks for a value when a field is emptied', () => {
		expect(message({ 'pitman.ST': '  ' }, 'pitman.ST')).toEqual({ level: 'error', text: 'Enter a value for ST, or reset it.' });
	});

	it('says what a number looks like when the text isn’t one', () => {
		expect(message({ 'pitman.POW': 'two' }, 'pitman.POW')?.text).toBe('POW must be a number, such as 2.0.');
	});

	it('names the limit in words', () => {
		expect(message({ 'pitman.R': '1.5' }, 'pitman.R')?.text).toBe('R must be between 0 and 1 (TT 690 p.5).');
		expect(message({ 'pitman.FT': '-1' }, 'pitman.FT')?.text).toBe('FT can’t be negative.');
		expect(message({ 'pitman.POW': '0' }, 'pitman.POW')?.text).toBe('POW must be more than 0.');
	});

	it('refuses a value the file can’t hold exactly, and offers the two nearest', () => {
		expect(message({ 'pitman.POW': '2.55' }, 'pitman.POW')?.text).toBe('The file keeps 1 decimal place for POW, so this can’t be saved exactly. Use 2.5 or 2.6.');
		expect(message({ 'pitman.ST': '200.5' }, 'pitman.ST')?.text).toBe('The file keeps whole numbers for ST, so this can’t be saved exactly. Use 200 or 201.');
	});

	it('refuses a value too long for the file', () => {
		expect(message({ 'pitman.FT': '123456' }, 'pitman.FT')?.text).toContain('too long');
	});

	it('warns from the manuals and lets it through', () => {
		const check = checkDrafts(classic, classicFields, { 'pitman.POW': '2.5', 'pitman.PI': '12' });
		expect(check.valid).toBe(true);
		expect(check.messages['pitman.POW']?.level).toBe('warning');
		expect(check.messages['pitman.PI']?.text).toContain('TT 690 p.2');
	});

	it('blames the field that was edited for a clash between two', () => {
		expect(message({ 'pitman.SL': String(classic.pitman.ST) }, 'pitman.SL')?.text).toContain('ST must be more than SL');
		expect(message({ 'pitman.ZMIN': String(classic.pitman.ZMAX + 1) }, 'pitman.ZMIN')?.text).toBe('ZMIN can’t be more than ZMAX.');
	});

	it('doesn’t judge a value that wasn’t edited', () => {
		const odd = { ...classic, pitman: { ...classic.pitman, POW: 2.55 } };
		expect(checkDrafts(odd, parameterFields(odd), { 'pitman.POW': '2.55' }).valid).toBe(true);
	});

	it('checks the Sami rules on a Sami module', () => {
		expect(message({ 'sami.pitman.R': '2' }, 'sami.pitman.R', sami)?.level).toBe('error');
		expect(message({ 'sami.storativity': '0.002' }, 'sami.storativity', sami)?.text).toContain('must be above SWL');
		expect(message({ 'sami.gwEvaporationArea': String(sami.areaKm2 + 1) }, 'sami.gwEvaporationArea', sami)?.text).toContain('EVAREA');
		expect(message({ 'sami.rechargeAveragingMonths': '0' }, 'sami.rechargeAveragingMonths', sami)?.text).toContain('whole number of months');
		expect(message({ 'sami.K3': '1' }, 'sami.K3', sami)?.level).toBe('warning');
		expect(message({ 'sami.HGSL': String(sami.sami?.pitman.ST) }, 'sami.HGSL', sami)?.text).toContain('HGSL must be below ST');
	});
});

describe('it refuses whatever the engine refuses', () => {
	/** Values on and past each limit, as text. */
	const probes = ['-1', '0', '0.5', '1', '2', '5', '500', '999'];

	it('for the Pitman parameters (OQ-16)', () => {
		for (const field of classicFields) {
			for (const probe of probes) {
				const text = probe;
				const next = withValues(classic, { [field.path]: Number(text) });
				const engineRefuses = validatePitmanParameters(next.pitman).some((m) => m.level === 'error');
				const check = checkDrafts(classic, classicFields, { [field.path]: text });
				if (engineRefuses) expect(check.valid, `${field.symbol} = ${text}`).toBe(false);
			}
		}
	});

	it('for the aquifer (R6-A4, R6-A8)', () => {
		const paths = ['sami.storativity', 'sami.aquiferThicknessM', 'sami.staticWaterLevelMm', 'sami.boreholeDistanceToRiver', 'sami.gwEvaporationArea'];
		for (const path of paths) {
			for (const probe of probes) {
				const next = withValues(sami, { [path]: Number(probe) }).sami;
				const params = { thicknessM: next?.aquiferThicknessM, storativity: next?.storativity, store0: 60, SWL: next?.staticWaterLevelMm, distM: next?.boreholeDistanceToRiver, evapAreaKm2: next?.gwEvaporationArea, areaKm2: sami.areaKm2 };
				let engineRefuses = false;
				try {
					samiAquiferInit(params as never);
				} catch {
					engineRefuses = true;
				}
				const check = checkDrafts(sami, samiFields, { [path]: probe });
				if (engineRefuses && Number(probe) !== fieldValue(sami, path)) expect(check.valid, `${path} = ${probe}`).toBe(false);
			}
		}
	});
});
