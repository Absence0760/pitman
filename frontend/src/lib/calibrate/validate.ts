/**
 * What the user typed, in plain language: a number the file can hold, in the
 * range the model accepts. An `error` stops the preview and the apply; a
 * `warning` is said and allowed. Every value the engine refuses
 * (`validatePitmanParameters`, OQ-16; the Sami parts, R6-A4, R6-A8, R6-S1,
 * R6-S2) is an error here first, so the user reads a sentence rather than a
 * failed run; `validate.test.ts` holds the two together. A value that wasn't
 * edited is never judged: a file that loaded isn't the user's mistake.
 */

import type { RunoffModule } from '@pitman/wrsm';
import { NO_UNIT, fieldValue, formatValue, type ParameterField } from './parameters.js';

export interface FieldMessage {
	readonly level: 'error' | 'warning';
	readonly text: string;
}

export interface DraftCheck {
	/** Every field's number: what was typed when it reads as one, else the module's. */
	readonly values: Readonly<Record<string, number>>;
	/** By field path. */
	readonly messages: Readonly<Record<string, FieldMessage>>;
	readonly valid: boolean;
}

/** A typed number; a decimal comma is accepted, as on the extension's factors. `null` when it isn't one. */
export function parseNumber(text: string): number | null {
	const t = text.trim().replace(',', '.');
	if (t === '') return null;
	const n = Number(t);
	return Number.isFinite(n) ? n : null;
}

function ruleMessage(field: ParameterField, n: number): string | null {
	const { symbol, unit, rule } = field;
	switch (rule) {
		case 'positive':
			return n > 0 ? null : `${symbol} must be more than 0${unit === NO_UNIT ? '' : ` ${unit}`}.`;
		case 'nonNegative':
			return n >= 0 ? null : `${symbol} can’t be negative.`;
		case 'fraction':
			return n >= 0 && n <= 1 ? null : `${symbol} must be between 0 and 1 (TT 690 p.5).`;
		case 'wholeFromOne':
			return Number.isInteger(n) && n >= 1 ? null : `${symbol} must be a whole number of months, 1 or more.`;
		case 'any':
			return null;
	}
}

/** Whether the file can hold `n` exactly: the same number on screen, in the run and in the saved file. */
function formatMessage(field: ParameterField, n: number): string | null {
	const { symbol, decimals, width } = field;
	const fixed = n.toFixed(decimals);
	if (fixed.length > width) return `${symbol} is too long for the file, which has ${width} characters for it.`;
	if (Number(fixed) === n) return null;
	const step = 10 ** decimals;
	const low = (Math.floor(n * step) / step).toFixed(decimals);
	const high = (Math.ceil(n * step) / step).toFixed(decimals);
	const keeps = decimals === 0 ? 'whole numbers' : decimals === 1 ? '1 decimal place' : `${decimals} decimal places`;
	return `The file keeps ${keeps} for ${symbol}, so this can’t be saved exactly. Use ${low} or ${high}.`;
}

/** Advice from the manuals: said, not enforced. */
function softMessage(field: ParameterField, n: number): string | null {
	switch (field.symbol) {
		case 'POW':
			return [1, 2, 3].includes(n) ? null : 'TT 689 Table 10.1 says POW should be 1, 2 or 3.';
		case 'PI':
			return n > 10 ? 'The interception curves were fitted to PI from 0 to 10 mm (TT 690 p.2).' : null;
		case 'PPOW':
			return n < 1 ? null : 'PPOW is expected to be below 1 (TT 689 Table 9.1 gives 0.2).';
		case 'k2':
			return n >= 0.05 && n <= 0.5 ? null : 'TT 690 Table 8.1 and TT 687 Table 2 give k2 from 0.05 to 0.5.';
		case 'k3':
			return n < 0 ? null : 'TT 690 Table 8.1 and TT 687 Table 2 give a negative k3.';
		default:
			return null;
	}
}

/** A rule between fields, blamed on the first of `paths` that was edited. */
interface CrossCheck {
	readonly paths: readonly string[];
	readonly ok: (v: (path: string) => number) => boolean;
	readonly text: string;
}

function crossChecks(module: RunoffModule, fields: readonly ParameterField[]): CrossCheck[] {
	const set = fields[0]?.path.startsWith('sami.') ? 'sami.pitman' : 'pitman';
	const checks: CrossCheck[] = [
		{ paths: [`${set}.ST`, `${set}.SL`], ok: (v) => v(`${set}.ST`) > v(`${set}.SL`), text: 'ST must be more than SL: the soil’s capacity has to sit above the level where subsurface flow starts.' },
		{ paths: [`${set}.ZMAX`, `${set}.ZMIN`], ok: (v) => v(`${set}.ZMIN`) <= v(`${set}.ZMAX`), text: 'ZMIN can’t be more than ZMAX.' }
	];
	if (set === 'sami.pitman') {
		checks.push(
			{ paths: ['sami.HGSL', 'sami.pitman.ST'], ok: (v) => v('sami.HGSL') < v('sami.pitman.ST'), text: 'HGSL must be below ST: recharge happens between the two.' },
			{
				paths: ['sami.aquiferThicknessM', 'sami.storativity', 'sami.staticWaterLevelMm'],
				ok: (v) => v('sami.aquiferThicknessM') * v('sami.storativity') * 1000 > v('sami.staticWaterLevelMm'),
				text: 'The aquifer’s capacity (THICK × Sy × 1000, in mm) must be above SWL (TT 691 p.209).'
			},
			{ paths: ['sami.gwEvaporationArea'], ok: (v) => v('sami.gwEvaporationArea') <= module.areaKm2, text: `EVAREA can’t be more than the catchment’s ${module.areaKm2} km².` }
		);
	}
	return checks;
}

/** Check what's been typed (`drafts`: path → text; a field left alone has no entry). */
export function checkDrafts(module: RunoffModule, fields: readonly ParameterField[], drafts: Readonly<Record<string, string>>): DraftCheck {
	const values: Record<string, number> = {};
	const messages: Record<string, FieldMessage> = {};
	const edited = new Set<string>();

	for (const field of fields) {
		const current = fieldValue(module, field.path);
		const text = drafts[field.path];
		const n = text === undefined ? current : parseNumber(text);
		if (n === null) {
			values[field.path] = current;
			messages[field.path] = { level: 'error', text: text?.trim() === '' ? `Enter a value for ${field.symbol}, or reset it.` : `${field.symbol} must be a number, such as ${formatValue(field, current)}.` };
			continue;
		}
		values[field.path] = n;
		if (n === current) continue;
		edited.add(field.path);
		const refused = ruleMessage(field, n) ?? formatMessage(field, n);
		if (refused !== null) {
			messages[field.path] = { level: 'error', text: refused };
			continue;
		}
		const advice = softMessage(field, n);
		if (advice !== null) messages[field.path] = { level: 'warning', text: advice };
	}

	const value = (path: string) => values[path] as number;
	for (const check of crossChecks(module, fields)) {
		const blame = check.paths.find((p) => edited.has(p));
		if (blame === undefined || check.ok(value)) continue;
		if (messages[blame]?.level !== 'error') messages[blame] = { level: 'error', text: check.text };
	}

	return { values, messages, valid: !Object.values(messages).some((m) => m.level === 'error') };
}
