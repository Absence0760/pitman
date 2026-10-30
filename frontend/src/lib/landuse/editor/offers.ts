/**
 * Which tables a runoff module offers and what the screen says about them.
 * The rules are the manuals' (TT 689 pp.127–140, docs/theory/afforestation.md
 * §4.1, alien.md §8):
 *
 * - An SFR child's climate and parameters come from its parent, but its
 *   land-use table is its own, and is read every run as its active area
 *   (`inheritFromParent`). So unlike Calibrate, which sends a child to its
 *   parent, this screen edits a child: the parent has no table to edit (R7-T5).
 * - A child holds one SFR and no paved area; a parent holds no afforestation or
 *   alien vegetation of its own. A table the rules forbid isn't offered, unless
 *   the file already has rows, which stay in view with a warning.
 */

import { LAND_USE_TABLES, sfrKind, tableOrderProblem, yearTableOf, type LandUseTable, type LandUseTableFormat, type NetworkBundle, type RunoffModule, type Sidecar } from '@pitman/wrsm';
import { calibrationCandidates, sfrParent } from '#lib/calibrate/candidates.js';

/** The year this screen brings a network up to (issue #3 goal 4). */
export const TARGET_YEAR = 2025;

export const TABLE_ORDER: readonly LandUseTable[] = ['afforestation', 'alienVegetation', 'paved'];

export const TABLE_TITLE: Readonly<Record<LandUseTable, string>> = { afforestation: 'Afforestation', alienVegetation: 'Alien vegetation', paved: 'Paved area' };

/** A column head and a chart's axis, so short enough for both. */
const VALUE_LABEL: Readonly<Record<LandUseTable, string>> = { afforestation: 'Afforested area, km²', alienVegetation: 'Alien vegetation area, km²', paved: 'Paved fraction (0–1)' };

const AFFORESTATION_ALGORITHM = ['Van der Zel', 'CSIR', 'Smoothed Gush/Pitman', 'LUT Gush', 'User-defined'] as const;
const ALIEN_ALGORITHM = ['None', 'CSIR', 'Riparian'] as const;

function runoffModule(bundle: NetworkBundle, number: number): RunoffModule | undefined {
	return bundle.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === number);
}

export function moduleLabel(module: RunoffModule): string {
	return `RU ${module.number}${module.name.trim() === '' ? '' : ` ${module.name.trim()}`}`;
}

export type ModuleRole = { readonly kind: 'free' } | { readonly kind: 'parent'; readonly children: readonly RunoffModule[] } | { readonly kind: 'child'; readonly parent: RunoffModule };

export function moduleRole(bundle: NetworkBundle, module: RunoffModule): ModuleRole {
	const parent = sfrParent(bundle, module.number);
	if (parent) return { kind: 'child', parent };
	const children = (module.sfrChildren ?? []).flatMap((n) => runoffModule(bundle, n) ?? []);
	return children.length > 0 ? { kind: 'parent', children } : { kind: 'free' };
}

export interface ModuleChoice {
	readonly number: number;
	readonly label: string;
	/** The last year of each table with rows. */
	readonly lastYears: readonly number[];
}

/** Every runoff module in `.NET` order, each saying how far its tables reach, so the ones to update can be found in a long list. */
export function moduleChoices(bundle: NetworkBundle): ModuleChoice[] {
	return calibrationCandidates(bundle).flatMap(({ number, label }) => {
		const module = runoffModule(bundle, number);
		if (!module) return [];
		const reach = TABLE_ORDER.flatMap((table) => {
			const last = yearTableOf(module, table).at(-1);
			return last ? [{ name: TABLE_TITLE[table].toLowerCase(), year: last.year }] : [];
		});
		const extent = reach.map((r) => `${r.name} to ${r.year}`).join(', ');
		return [{ number, label: extent === '' ? label : `${label} (${extent})`, lastYears: reach.map((r) => r.year) }];
	});
}

/** The sentence above the picker: what there is to do across the network. */
export function coverageSummary(choices: readonly ModuleChoice[]): string {
	const withTables = choices.filter((c) => c.lastYears.length > 0);
	const behind = withTables.filter((c) => c.lastYears.some((y) => y < TARGET_YEAR));
	if (withTables.length === 0) return `None of the ${choices.length} runoff modules has a land-use table yet.`;
	return `${withTables.length} of the ${choices.length} runoff modules have land-use tables; ${behind.length === 0 ? `all reach ${TARGET_YEAR}` : `${behind.length} stop before ${TARGET_YEAR}`}.`;
}

/** A piece of a sub-divided quaternary, or an SFR child split with its parent. */
export interface PieceOrigin {
	readonly quaternary: string;
	/** The module it came from. */
	readonly original: number;
	/** How that module's tables were shared among the pieces. */
	readonly basis: Readonly<Record<LandUseTable, string>>;
}

export function pieceOrigin(sidecar: Sidecar | undefined, number: number): PieceOrigin | undefined {
	for (const [quaternary, entry] of Object.entries(sidecar?.subdivisions ?? {})) {
		const child = entry.children?.find((c) => c.pieces.includes(number));
		if (!child && !entry.pieces.some((p) => p.number === number)) continue;
		const by = (basis: string) => (basis === 'location' ? 'split by location' : 'split by area');
		return {
			quaternary,
			original: child?.number ?? entry.module.number,
			basis: { afforestation: by(entry.shares.afforestation), alienVegetation: by(entry.shares.alien), paved: 'copied as a fraction' }
		};
	}
	return undefined;
}

export interface TableOffer {
	readonly table: LandUseTable;
	readonly title: string;
	readonly format: LandUseTableFormat;
	/** The column's name with its unit. */
	readonly valueLabel: string;
	/** Whether rows can be added and changed. */
	readonly open: boolean;
	/** Whether the table is on the screen. */
	readonly shown: boolean;
	/** Why it isn't open, or isn't there, and what to do instead. */
	readonly why: string | null;
	/** What a run does with this table in this module. */
	readonly notes: readonly string[];
	/** The file's other lines for this table, read-only here. */
	readonly facts: string | null;
	/** Where the rows came from, when the log doesn't say otherwise. */
	readonly origin: string;
}

function tableFacts(module: RunoffModule, table: LandUseTable): string | null {
	if (table === 'afforestation') {
		const a = module.afforestation;
		const algorithm = `Algorithm: ${AFFORESTATION_ALGORITHM[a.algorithm]} (L.006)`;
		if (!a.species) return `${algorithm}.`;
		const { pine, eucalyptus, wattle } = a.species;
		const shares = [`pine ${pine.percent} %, ${pine.rotationYears}-year rotation`, `eucalyptus ${eucalyptus.percent} %, ${eucalyptus.rotationYears}-year rotation`, `wattle ${wattle.percent} %, ${wattle.rotationYears}-year rotation`];
		return `${algorithm}; ${shares.join('; ')} (L.009); optimal ${a.optimalPercent ?? 0} % (L.010).`;
	}
	if (table === 'alienVegetation') {
		const v = module.alienVegetation;
		if (!v) return null;
		const algorithm = `Algorithm: ${ALIEN_ALGORITHM[v.algorithm]} (L.011)`;
		if (!v.composition) return `${algorithm}.`;
		const { tallTrees, mediumTrees, tallShrubs } = v.composition;
		const shares = [`tall trees ${tallTrees.percent} %, ${tallTrees.ageYears} years old`, `medium trees ${mediumTrees.percent} %, ${mediumTrees.ageYears} years old`, `tall shrubs ${tallShrubs.percent} %, ${tallShrubs.ageYears} years old`];
		return `${algorithm}; ${shares.join('; ')} (L.014); optimal ${v.optimalPercent ?? 0} % (L.015).`;
	}
	return null;
}

/** Why the rules keep this table from having rows, in the words of the way out. */
function refusal(module: RunoffModule, table: LandUseTable, role: ModuleRole): string | null {
	if (table === 'alienVegetation' && module.fileVersion < 1) return 'This module’s file is version 0, which has no alien vegetation lines (L.011–L.015). Save it from WRSM2000 in a newer version to add them.';
	if (role.kind === 'parent' && table !== 'paved') return `A parent holds no ${TABLE_TITLE[table].toLowerCase()} of its own (TT 689 p.140): it goes in one of its children’s tables.`;
	if (role.kind === 'child') {
		if (table === 'paved') return `A child can’t hold paved area (TT 689 p.140): put it on RU ${role.parent.number}, its parent.`;
		const kind = sfrKind(module);
		if (table === 'alienVegetation' && kind === 'forest') return `A child holds one kind of land use, and this one is afforested (TT 691 p.52). Alien vegetation needs a child of its own under RU ${role.parent.number}.`;
		if (table === 'afforestation' && kind === 'alien') return `A child holds one kind of land use, and this one has alien vegetation (TT 691 p.52). Afforestation needs a child of its own under RU ${role.parent.number}.`;
	}
	return null;
}

function tableNotes(module: RunoffModule, table: LandUseTable, role: ModuleRole, hasRows: boolean): string[] {
	const notes: string[] = [];
	if (table === 'afforestation' && hasRows && role.kind === 'free') {
		notes.push('A run takes no flow reduction from afforestation in a free module yet: the area is checked and saved, but the reduction outside an SFR child isn’t in the manuals (R6-F3 to R6-F5).');
	}
	if (table === 'alienVegetation' && hasRows && module.alienVegetation?.algorithm === 0) {
		notes.push('This module’s alien vegetation algorithm is None (L.011), so a run ignores this table until it is set in WRSM2000.');
	}
	if (role.kind === 'child' && table === 'paved' && hasRows) notes.push('A run ignores these rows: a child can’t hold paved area (TT 689 p.140).');
	if (role.kind === 'parent' && table !== 'paved' && hasRows) notes.push('The manual doesn’t allow this on a parent (TT 689 p.140): the area belongs in a child’s table.');
	if (role.kind === 'child' && table === 'alienVegetation' && hasRows && sfrKind(module) === 'forest') notes.push('This child has afforestation too, and a child holds one kind: a run uses the afforestation and ignores these rows (R6-F11).');
	if (!hasRows && table === 'afforestation' && !module.afforestation.species && module.fileVersion >= 1) {
		notes.push('The file has no species split for this module (L.009). The first year saves it with 0 % of each genus, so set the split in WRSM2000 before relying on a run.');
	}
	if (!hasRows && table === 'alienVegetation' && !module.alienVegetation?.composition) {
		notes.push('The file has no composition for this module (L.014). The first year saves it with 0 % of each class, so set it in WRSM2000 before relying on a run.');
	}
	return notes;
}

/** What the module offers for one table. `fileName` is the module's file as the network has it. */
export function tableOffer(bundle: NetworkBundle, module: RunoffModule, table: LandUseTable, fileName: string): TableOffer {
	const format = LAND_USE_TABLES[table];
	const rows = yearTableOf(module, table);
	const role = moduleRole(bundle, module);
	const refused = refusal(module, table, role);
	const order = tableOrderProblem(rows);
	const piece = pieceOrigin(bundle.sidecar, module.number);
	const lines = `${format.yearsLine}–${format.valuesLine}`;
	return {
		table,
		title: TABLE_TITLE[table],
		format,
		valueLabel: VALUE_LABEL[table],
		open: refused === null && order === null,
		shown: refused === null || rows.length > 0,
		why: order !== null ? `${order} This screen can’t tell which row an edit means, so correct the module’s file (${fileName}, ${lines}) and load it again.` : refused,
		notes: tableNotes(module, table, role, rows.length > 0),
		facts: tableFacts(module, table),
		origin: `${piece ? `From RU ${piece.original}’s table, ${piece.basis[table]} in the ${piece.quaternary} sub-division` : `From ${fileName}, ${lines}`}${table === 'paved' ? ', as a fraction of the catchment' : ''}`
	};
}
