/**
 * Splitting a runoff module and rewiring the network around its pieces
 * (docs/theory/subdivide.md § Splitting the module and the network).
 *
 * `rewire` does the work on a `Draft`, where routes name modules rather than
 * `.NET` positions (TT 691 §12.6 L.014), so an insertion moves nothing;
 * positions are worked out once at the end. `previewSplit` shows the result
 * and `applySplit` keeps it, with the calibrated MAPs and the sidecar entry.
 * `mergePieces` is the inverse for a module's fields (invariant 8).
 */

import { moduleType, placeModules } from '../network/modules.js';
import { validateNetwork } from '../network/validate.js';
import { sfrKind } from '../landuse/sfr.js';
import type {
	Afforestation,
	AlienVegetation,
	DamRecord,
	IrrigationModule,
	Module,
	ModuleTypeCode,
	Network,
	NetworkBundle,
	ReservoirCapacity,
	ReservoirModule,
	RunoffModule,
	RunoffOutflow,
	Sidecar,
	Subdivision,
	SubdivisionChild,
	SubdivisionPiece,
	YearTable
} from '../types.js';
import { fileRound, largestRemainder, scalePieceAreas } from './areas.js';
import { MAR_TOLERANCE, planNaturalMar, roundMap } from './calibrate.js';
import type { ApplySplitOptions, PiecePlan, PreviewSplit, ShareBasis, SplitPlan, SplitPreview } from './contract.js';
import { pointInGeometry } from './zones.js';
import { findRunoff, hughesPieces, plannedModule, samiPieces, siblingsOf, splitYearTable, subdivisionOf, SubdivisionError } from './pieces.js';
import { carryValues, type SplitLineage } from './values.js';

/** Afforestation and alien tables are `F0.1` (RU L.008, L.013); RV capacity and area `F0.2` (L.005, L.006); RV initial storage `F8.3` (L.015); RR area `F0.2` (L.006), RRMA `F0.2` (L.013), allocation `F0.3` (L.024). */
const TABLE_DECIMALS = 1;
const DAM_DECIMALS = 2;
const STORAGE_DECIMALS = 3;
const IRRIGATION_DECIMALS = 2;
const ALLOCATION_DECIMALS = 3;
/** RU names are `CHARACTER(LEN=20)` (TT 691 p.103, RUNAM). */
const NAME_LENGTH = 20;
/** Module numbers are 1–4 digits (TT 689 §2.3.1), route numbers 1–9999 (docs/formats.md §4). */
const MAX_NUMBER = 9999;

type Key = string;
const keyOf = (type: ModuleTypeCode, number: number): Key => `${type}${number}`;
const keyOfModule = (m: Module): Key => keyOf(moduleType(m), m.number);

interface DraftRoute {
	readonly number: number;
	readonly up: Key | null;
	readonly down: Key | null;
	readonly cost: number;
}

/** A network being rewired: the module list in order, the modules by key, routes by module key. */
class Draft {
	private readonly order: Key[];
	private readonly modules = new Map<Key, Module>();
	private readonly solve = new Map<Key, boolean>();
	private readonly removed = new Set<Key>();
	private routes: DraftRoute[];
	private readonly next: Record<'RU' | 'RV' | 'RR' | 'route', number>;
	readonly changes: string[] = [];
	readonly messages: string[] = [];

	constructor(private readonly source: NetworkBundle) {
		const placed = placeModules(source);
		const { network } = source;
		this.order = placed.map((p) => keyOf(p.entry.type, p.entry.number));
		for (const p of placed) {
			const key = keyOf(p.entry.type, p.entry.number);
			if (p.module) this.modules.set(key, p.module);
			this.solve.set(key, p.entry.solve);
		}
		const at = (position: number): Key | null => this.order[position - 1] ?? null;
		this.routes = network.routes.map((r) => ({ number: r.number, up: at(r.upstreamPosition), down: at(r.downstreamPosition), cost: r.cost }));
		const largest = (type: ModuleTypeCode) => Math.max(0, ...network.modules.filter((e) => e.type === type).map((e) => e.number));
		this.next = { RU: largest('RU') + 1, RV: largest('RV') + 1, RR: largest('RR') + 1, route: Math.max(0, ...network.routes.map((r) => r.number)) + 1 };
	}

	number(kind: 'RU' | 'RV' | 'RR' | 'route'): number {
		const n = this.next[kind]++;
		if (n > MAX_NUMBER) throw new SubdivisionError(`no ${kind === 'route' ? 'route' : `${kind} module`} number is left: they stop at ${MAX_NUMBER}`);
		return n;
	}

	module(key: Key | null): Module | undefined {
		return key === null ? undefined : this.modules.get(key);
	}

	route(number: number): DraftRoute | undefined {
		return this.routes.find((r) => r.number === number);
	}

	set(module: Module): void {
		this.modules.set(keyOfModule(module), module);
	}

	/** Add a module to the list immediately before `before`. */
	insert(module: Module, before: Key): void {
		const key = keyOfModule(module);
		this.order.splice(this.order.indexOf(before), 0, key);
		this.modules.set(key, module);
		this.solve.set(key, this.solve.get(before) ?? true);
	}

	addRoute(up: Key | null, down: Key | null): number {
		const number = this.number('route');
		this.routes.push({ number, up, down, cost: 0 });
		return number;
	}

	/** Take a module out with its routes, and those routes off the modules at their other ends. */
	remove(key: Key): void {
		for (const r of this.routes) {
			if (r.up !== key && r.down !== key) continue;
			const other = this.module(r.up === key ? r.down : r.up);
			if (other) this.set(withoutRoute(other, r.number));
		}
		this.routes = this.routes.filter((r) => r.up !== key && r.down !== key);
		this.order.splice(this.order.indexOf(key), 1);
		this.modules.delete(key);
		this.removed.add(key);
	}

	/** The rewired network and module list, positions recomputed. */
	finish(): { readonly network: Network; readonly modules: readonly Module[] } {
		const position = new Map(this.order.map((k, i) => [k, i + 1]));
		const at = (key: Key | null) => (key === null ? 0 : position.get(key)!);
		const inList = new Set(this.order);
		const entries = this.order.map((k) => {
			const m = /^([A-Z]+)(\d+)$/.exec(k)!;
			return { number: Number(m[2]), type: m[1] as ModuleTypeCode, solve: this.solve.get(k) ?? true };
		});
		return {
			network: {
				...this.source.network,
				modules: entries,
				routes: this.routes.map((r) => ({ number: r.number, upstreamPosition: at(r.up), downstreamPosition: at(r.down), cost: r.cost }))
			},
			modules: [
				...this.order.flatMap((k) => {
					const m = this.modules.get(k);
					return m ? [m] : [];
				}),
				...this.source.modules.filter((m) => !inList.has(keyOfModule(m)) && !this.removed.has(keyOfModule(m)))
			]
		};
	}
}

function withoutRoute(module: Module, route: number): Module {
	switch (module.kind) {
		case 'RU':
			return { ...module, outflows: module.outflows.filter((o) => o.route !== route) };
		case 'RV':
			return { ...module, inflows: module.inflows.filter((c) => c.route !== route), outflows: module.outflows.filter((c) => c.route !== route) };
		case 'CR':
			return { ...module, inflows: module.inflows.filter((c) => c.route !== route), outflows: module.outflows.filter((c) => c.route !== route) };
		default:
			return module;
	}
}

/** A module a new route can end at by adding an inflow line: the zero sink, a reservoir or a channel. */
function takesInflow(d: Draft, key: Key | null): boolean {
	if (key === null) return true;
	const m = d.module(key);
	return m?.kind === 'RV' || m?.kind === 'CR';
}

/** Add a route ending at `key` to that module's inflows. */
function addInflow(d: Draft, key: Key | null, route: number): void {
	const m = d.module(key);
	if (m?.kind === 'RV' || m?.kind === 'CR') d.set({ ...m, inflows: [...m.inflows, { route, definedFlowFile: null }] });
}

const label = (key: Key | null) => (key === null ? 'the zero sink' : key.replace(/^([A-Z]+)/, '$1 '));

function shortName(name: string, suffix: string): string {
	return `${name.slice(0, NAME_LENGTH - suffix.length - 1).trimEnd()} ${suffix}`;
}

function pieceSuffix(role: PiecePlan['role'], number: number): string {
	return `${role === 'tributary' ? 'T' : role === 'zone' ? 'Z' : 'P'}${number}`;
}

/** The farm-dam pattern (subdivide.md § Routes): `M → V` at `p %`, `M → X` the rest, `V` spills to `X`, and `V` takes only `M`'s outflow. */
interface FarmDam {
	readonly key: Key;
	readonly reservoir: ReservoirModule;
	readonly feed: RunoffOutflow;
	readonly bypass: RunoffOutflow | undefined;
	readonly downstream: Key | null;
}

function farmDam(d: Draft, module: RunoffModule): FarmDam | null {
	const self = keyOfModule(module);
	const feeds = module.outflows.flatMap((feed) => {
		const reservoir = d.module(d.route(feed.route)?.down ?? null);
		if (reservoir?.kind !== 'RV' || reservoir.inflows.length === 0) return [];
		return reservoir.inflows.every((c) => !c.definedFlowFile && d.route(c.route)?.up === self) ? [{ feed, reservoir }] : [];
	});
	const found = feeds.length === 1 ? feeds[0]! : undefined;
	if (!found) return null;
	const others = module.outflows.filter((o) => o !== found.feed);
	if (others.length > 1) return null;
	const spill = d.route(found.reservoir.spillRoute);
	if (!spill || !takesInflow(d, spill.down)) return null;
	const bypass = others[0];
	if (bypass && d.route(bypass.route)?.down !== spill.down) return null;
	return { key: keyOfModule(found.reservoir), reservoir: found.reservoir, feed: found.feed, bypass, downstream: spill.down };
}

function outletIndex(plan: SplitPlan): number {
	const { pieces } = plan;
	if (plan.layout === 'series') {
		const remainder = pieces.findIndex((p) => p.role === 'remainder');
		if (remainder >= 0) return remainder;
	}
	const largest = Math.max(...pieces.map((p) => p.polygonKm2));
	const tied = pieces.map((p, i) => ({ p, i })).filter(({ p }) => p.polygonKm2 === largest);
	return (tied.find(({ p }) => p.role === 'rest' || p.role === 'remainder') ?? tied[0]!).i;
}

type LocationField = keyof NonNullable<PiecePlan['locationShares']>;

function locationShares(plan: SplitPlan, field: LocationField): number[] {
	const shares = plan.pieces.map((p) => p.locationShares?.[field]);
	if (shares.some((s) => s === undefined || !(s >= 0))) throw new SubdivisionError(`the plan shares ${field} by location, but not every piece gives its share`);
	const values = shares as number[];
	const sum = values.reduce((a, b) => a + b, 0);
	if (Math.abs(sum - 1) > 1e-6) throw new SubdivisionError(`the pieces' ${field} shares add up to ${sum}, not 1`);
	return values;
}

function tableShares(plan: SplitPlan, basis: ShareBasis, field: LocationField, areaShares: readonly number[]): readonly number[] {
	return basis === 'location' ? locationShares(plan, field) : areaShares;
}

/** Every piece's share of a farm dam's capacity and surface area: located dams, or the total by area (subdivide.md § Farm dams). */
function damShares(plan: SplitPlan, areaShares: readonly number[]) {
	if (plan.shares.dams === 'area') return { capacity: areaShares, area: areaShares };
	const capacity = locationShares(plan, 'damCapacity');
	const area = plan.pieces.every((p) => p.locationShares?.damArea !== undefined) ? locationShares(plan, 'damArea') : capacity;
	return { capacity, area };
}

/** One capacity table per piece, each row's volume and area kept. */
function splitCapacity(table: readonly ReservoirCapacity[], shares: { capacity: readonly number[]; area: readonly number[] }): ReservoirCapacity[][] {
	const volumes = table.map((row) => largestRemainder(row.fullSupplyVolumeMm3, shares.capacity, DAM_DECIMALS));
	const areas = table.map((row) => largestRemainder(row.fullSupplyAreaKm2, shares.area, DAM_DECIMALS));
	return shares.capacity.map((_, i) => table.map((row, r) => ({ year: row.year, fullSupplyVolumeMm3: volumes[r]![i]!, fullSupplyAreaKm2: areas[r]![i]! })));
}

/**
 * The initial storage (RV L.015) per piece, with the capacity. A negative
 * value means "50 % of full supply" (TT 691 p.158, reservoir.ts), so it is
 * copied, never divided. Only pieces with dams share it, and none starts above
 * its first year's capacity (R5-E4).
 */
function splitStorage(storage: number, shares: readonly number[], hasDams: readonly boolean[], capacity: readonly (readonly ReservoirCapacity[])[], outlet: number): number[] {
	if (storage < 0) return shares.map(() => storage);
	const live = shares.map((s, i) => (hasDams[i] ? s : 0));
	if (!live.some((s) => s > 0)) return shares.map((_, i) => (i === outlet ? storage : 0));
	return largestRemainder(storage, live, STORAGE_DECIMALS).map((v, i) => Math.min(v, capacity[i]?.[0]?.fullSupplyVolumeMm3 ?? v));
}

function withLandUse(module: RunoffModule, afforestation: YearTable, alien: YearTable | undefined): RunoffModule {
	const forest: Afforestation = { ...module.afforestation, areaKm2: afforestation };
	const vegetation: AlienVegetation | undefined = module.alienVegetation && alien ? { ...module.alienVegetation, areaKm2: alien } : module.alienVegetation;
	return { ...module, afforestation: forest, ...(vegetation ? { alienVegetation: vegetation } : {}) };
}

interface IrrigationBlock {
	readonly number: number;
	readonly pieces: readonly number[];
}

/** What `rewire` hands back: the network, and what the screen and the sidecar need. */
interface Rewired {
	readonly network: Network;
	readonly modules: readonly Module[];
	readonly outlet: number;
	readonly numbers: readonly number[];
	readonly areasKm2: readonly number[];
	readonly scaleWarning: string | null;
	readonly children: readonly SubdivisionChild[];
	readonly irrigation: ShareBasis | undefined;
	readonly irrigationOwners: readonly { readonly number: number; readonly piece: number }[];
	/** Each RR split, and the RRs that hold it now. */
	readonly irrigationBlocks: readonly IrrigationBlock[];
	/** The farm-dam reservoir and each copy of it, when the module has the pattern. */
	readonly reservoirs: { readonly number: number; readonly pieces: readonly number[] } | undefined;
	readonly module: RunoffModule;
	readonly changes: readonly string[];
	readonly messages: readonly string[];
}

/**
 * Split `plan.module` and rewire. `maps` are the MAPs to write, in the plan's
 * piece order, then the quaternary's other pieces (see `siblingsOf`).
 */
function rewire(bundle: NetworkBundle, plan: SplitPlan, maps: readonly number[]): Rewired {
	const module = plannedModule(bundle, plan);
	const siblings = siblingsOf(bundle, plan);
	const { pieces } = plan;
	if (maps.length !== pieces.length + siblings.length) throw new SubdivisionError(`the calibration has ${maps.length} MAPs for ${pieces.length + siblings.length} pieces: calibrate this plan again`);

	const d = new Draft(bundle);
	const self = keyOfModule(module);
	const { areasKm2, warning: scaleWarning } = scalePieceAreas(module.areaKm2, pieces.map((p) => p.polygonKm2));
	if (areasKm2.some((a) => !(a > 0))) throw new SubdivisionError(`a piece would round to no area in RU ${module.number}`);
	const areaShares = areasKm2.map((a) => a / module.areaKm2);
	const outlet = outletIndex(plan);
	const numbers = pieces.map((_, i) => (i === outlet ? module.number : d.number('RU')));
	const dam = farmDam(d, module);
	const entry = subdivisionOf(bundle, plan.quaternary);
	// R5-E7 binds a quaternary where there are dams: a piece left with none has no basis to mix.
	if (dam?.reservoir.capacity.some((row) => row.fullSupplyVolumeMm3 > 0 || row.fullSupplyAreaKm2 > 0) && entry && entry.shares.dams !== plan.shares.dams) {
		throw new SubdivisionError(`${plan.quaternary}'s farm dams were shared by ${entry.shares.dams}: within one quaternary either every dam is located or the total is shared`);
	}

	// Extensive tables and the area-dependent groundwater fields (subdivide.md § Fields; R5-E1, R5-E2).
	const aff = splitYearTable(module.afforestation.areaKm2, module.afforestation.areaKm2.length > 0 ? tableShares(plan, plan.shares.afforestation, 'afforestation', areaShares) : areaShares, TABLE_DECIMALS);
	const alienTable = module.alienVegetation?.areaKm2 ?? [];
	const alien = splitYearTable(alienTable, alienTable.length > 0 ? tableShares(plan, plan.shares.alien, 'alien', areaShares) : areaShares, TABLE_DECIMALS);
	const sami = samiPieces(module, areasKm2);
	const hughes = hughesPieces(module, areasKm2);
	const pieceFields = (i: number) => ({
		...withLandUse(module, aff[i]!, module.alienVegetation ? alien[i]! : undefined),
		areaKm2: areasKm2[i]!,
		mapMm: maps[i]!,
		...(sami ? { sami: sami[i]! } : {}),
		...(hughes ? { hughes: hughes[i]! } : {})
	});

	// Farm dams: capacity and surface area by year, and the initial storage with the capacity (R5-E4).
	const dams = dam ? damShares(plan, areaShares) : undefined;
	const capacity = dam && dams ? splitCapacity(dam.reservoir.capacity, dams) : undefined;
	const hasDams = pieces.map((_, i) => capacity?.[i]!.some((row) => row.fullSupplyVolumeMm3 > 0 || row.fullSupplyAreaKm2 > 0) ?? false);
	const initial = dam && dams && capacity && dam.reservoir.initialStorageMm3 !== undefined ? splitStorage(dam.reservoir.initialStorageMm3, dams.capacity, hasDams, capacity, outlet) : undefined;
	capacity?.forEach((rows, i) => {
		if (hasDams[i] && rows.some((row) => row.fullSupplyVolumeMm3 > 0 && row.fullSupplyAreaKm2 === 0)) {
			d.messages.push(`The dams in piece ${numbers[i]} round to no surface area, so they get no rain or evaporation.`);
		}
	});
	const reservoirKeys = new Map<number, Key>();
	const reservoirCopies: number[] = [];

	// The pieces that aren't the outlet: their modules, routes and farm dams.
	const joining: Key[] = [];
	const pieceKey = (i: number) => keyOf('RU', numbers[i]!);
	pieces.forEach((plan_, i) => {
		if (i === outlet) return;
		const key = pieceKey(i);
		const number = numbers[i]!;
		const piece: RunoffModule = {
			...pieceFields(i),
			number,
			name: shortName(module.name, pieceSuffix(plan_.role, number)),
			outflows: [],
			...(module.inflowRoute !== undefined ? { inflowRoute: 0 } : {}),
			...(module.upstreamGroundwaterModule !== undefined ? { upstreamGroundwaterModule: 0 } : {}),
			...(module.sfrChildren !== undefined ? { sfrChildren: [] } : {})
		};
		d.insert(piece, self);
		d.changes.push(`New runoff module RU ${number} (${plan_.role}), ${areasKm2[i]} km², before RU ${module.number}.`);
		const outflows: RunoffOutflow[] = [];
		const send = (down: Key | null, percent: number) => {
			const route = d.addRoute(key, down);
			addInflow(d, down, route);
			outflows.push({ route, percent });
			d.changes.push(`Route ${route}: RU ${number} → ${label(down)} (${percent} %).`);
			return route;
		};
		if (dam) {
			if (hasDams[i]) {
				const reservoir = dam.reservoir;
				const vNumber = d.number('RV');
				const vKey = keyOf('RV', vNumber);
				const copy: ReservoirModule = { ...reservoir, number: vNumber, name: shortName(reservoir.name, `V${vNumber}`), capacity: capacity![i]!, inflows: [], outflows: [] };
				const { initialStorageMm3: _dropped, ...rest } = copy;
				d.insert(initial ? { ...rest, initialStorageMm3: initial[i]! } : rest, self);
				reservoirKeys.set(i, vKey);
				reservoirCopies.push(vNumber);
				d.changes.push(`New reservoir RV ${vNumber}, a copy of RV ${reservoir.number} for the dams in RU ${number}.`);
				for (const o of module.outflows) send(o === dam.feed ? vKey : dam.downstream, o.percent);
				const spill = d.addRoute(vKey, dam.downstream);
				addInflow(d, dam.downstream, spill);
				const v = d.module(vKey) as ReservoirModule;
				d.set({ ...v, spillRoute: spill, outflows: [{ route: spill, definedFlowFile: null }] });
				d.changes.push(`Route ${spill}: RV ${vNumber} spills to ${label(dam.downstream)}.`);
			} else {
				send(dam.downstream, 100);
			}
		} else if (plan.layout === 'sideBySide' && module.outflows.every((o) => takesInflow(d, d.route(o.route)?.down ?? null))) {
			for (const o of module.outflows) send(d.route(o.route)?.down ?? null, o.percent);
		} else {
			const largest = module.outflows.reduce((a, b) => (b.percent > a.percent ? b : a));
			const down = d.route(largest.route)?.down ?? null;
			if (plan.layout === 'series' && takesInflow(d, down)) {
				send(down, 100);
				d.changes.push(`RU ${module.number}'s outflow doesn't match the farm-dam pattern: RU ${number} goes to ${label(down)}, where its largest outflow route ends. Please confirm.`);
			} else {
				joining.push(key);
			}
		}
		d.set({ ...(d.module(key) as RunoffModule), outflows });
	});

	// A piece whose destination can't take another inflow (an RTIN is taken, an irrigation block, an unread module) joins through the next RTIN down to the outlet (B1, R3-N8, R5-E5).
	if (joining.length > 0) {
		if (module.inflowRoute) throw new SubdivisionError(`RU ${module.number}'s water goes where no second route can join it, and its own inflow route is taken, so the pieces can't be connected`);
		// L.021 exists from file version 3 (docs/formats.md §5.2), and the writer keeps a module's version.
		if (module.fileVersion < 3) throw new SubdivisionError(`RU ${module.number}'s water goes where no second route can join it, and its file version ${module.fileVersion} has no inflow route, so the pieces can't be connected`);
		joining.forEach((key, k) => {
			const target = joining[k + 1] ?? self;
			const route = d.addRoute(key, target);
			const from = d.module(key) as RunoffModule;
			d.set({ ...from, outflows: [{ route, percent: 100 }] });
			const to = d.module(target) as RunoffModule;
			d.set({ ...to, inflowRoute: route });
			d.changes.push(`Route ${route}: ${label(key)} → ${label(target)}, as its inflow route.`);
			d.changes.push(`${label(key)} can't reach RU ${module.number}'s destination, so it flows into ${label(target)}. Please confirm.`);
		});
	}

	// The outlet keeps the number, its routes, any inflow route and the reservoir.
	const outletBefore = d.module(self) as RunoffModule;
	d.set({ ...pieceFields(outlet), name: module.name, outflows: outletBefore.outflows, ...(outletBefore.inflowRoute !== undefined ? { inflowRoute: outletBefore.inflowRoute } : {}) });
	if (dam) {
		const { initialStorageMm3: _dropped, ...rest } = d.module(dam.key) as ReservoirModule;
		d.set(initial ? { ...rest, capacity: capacity![outlet]!, initialStorageMm3: initial[outlet]! } : { ...rest, capacity: capacity![outlet]! });
		d.changes.push(`RV ${dam.reservoir.number} keeps the dams in RU ${module.number}.`);
		if (!hasDams[outlet]) d.messages.push(`No dams are left in RU ${module.number}: RV ${dam.reservoir.number} stays with no capacity.`);
	}

	const children = splitChildren(d, bundle, plan, module, { maps, numbers, outlet, areaShares });

	// A piece with no dams of its own may own blocks on another piece's `V`: its split takes those, whatever the pattern says (R5-E10).
	const owned = entry?.irrigation ?? [];
	const irrigation = splitIrrigation(d, plan, {
		damKey: dam?.key ?? null,
		numbers,
		outlet,
		areaShares,
		reservoirKeys,
		self,
		foreign: new Set(owned.filter((o) => o.piece !== module.number).map((o) => o.number)),
		own: new Set(owned.filter((o) => o.piece === module.number).map((o) => o.number))
	});

	// R5-E11: the outlet keeps the routes, so a gauge on one now sees only the outlet's share of the quaternary's water.
	// Not when every other piece joins through its inflow route: then the routes still carry it all.
	if (joining.length < pieces.length - 1) {
		for (const gauge of bundle.network.gauges) {
			if (module.outflows.some((o) => o.route === gauge.route)) {
				d.messages.push(`The gauge on route ${gauge.route} leaves RU ${module.number}: after the split it sees only that piece's runoff, so its observed flow no longer compares with the route.`);
			}
		}
	}

	// The D2 factor scales every piece of the quaternary, and each child with its parent.
	siblings.forEach((s, k) => {
		const mapMm = maps[pieces.length + k]!;
		d.set({ ...s.module, mapMm });
		for (const c of s.module.sfrChildren ?? []) {
			const child = findRunoff(bundle.modules, c);
			if (child) d.set({ ...child, mapMm: childMap(child, s.module.mapMm, mapMm) });
		}
	});

	const reservoirs = dam ? { number: dam.reservoir.number, pieces: [dam.reservoir.number, ...reservoirCopies] } : undefined;
	return { ...d.finish(), outlet, numbers, areasKm2, scaleWarning, children, irrigation: irrigation?.basis, irrigationOwners: irrigation?.owners ?? [], irrigationBlocks: irrigation?.blocks ?? [], reservoirs, module, changes: d.changes, messages: d.messages };
}

/** `MAP_child,i = MAP_i · MAP_child / MAP_M` (subdivide.md § SFR parent and children). */
function childMap(child: RunoffModule, parentBefore: number, parentAfter: number): number {
	return Math.max(1, roundMap((parentAfter * child.mapMm) / parentBefore));
}

/** Each SFR child of the module becomes one child per piece with a share of it (subdivide.md § SFR parent and children, B5). */
function splitChildren(
	d: Draft,
	bundle: NetworkBundle,
	plan: SplitPlan,
	module: RunoffModule,
	at: { maps: readonly number[]; numbers: readonly number[]; outlet: number; areaShares: readonly number[] }
): SubdivisionChild[] {
	const records: SubdivisionChild[] = [];
	const lists: number[][] = plan.pieces.map(() => []);
	const self = keyOfModule(module);
	for (const number of module.sfrChildren ?? []) {
		const child = findRunoff(bundle.modules, number);
		if (!child) throw new SubdivisionError(`RU ${module.number} names SFR child RU ${number}, which isn't in the network`);
		const kind = sfrKind(child);
		const shares = kind === 'forest' ? tableShares(plan, plan.shares.afforestation, 'afforestation', at.areaShares) : kind === 'alien' ? tableShares(plan, plan.shares.alien, 'alien', at.areaShares) : at.areaShares;
		const areas = largestRemainder(child.areaKm2, shares, TABLE_DECIMALS);
		const made = areas.flatMap((a, i) => (a > 0 ? [i] : []));
		if (made.length === 0) throw new SubdivisionError(`SFR child RU ${number} has no area to share out`);
		const madeShares = shares.map((s, i) => (made.includes(i) ? s : 0));
		const aff = splitYearTable(child.afforestation.areaKm2, madeShares, TABLE_DECIMALS);
		const alien = splitYearTable(child.alienVegetation?.areaKm2 ?? [], madeShares, TABLE_DECIMALS);
		const pieces: number[] = [];
		for (const i of made) {
			const fields = { ...withLandUse(child, aff[i]!, child.alienVegetation ? alien[i]! : undefined), areaKm2: areas[i]!, mapMm: childMap(child, module.mapMm, at.maps[i]!) };
			if (i === at.outlet) {
				d.set(fields);
				pieces.push(number);
				lists[i]!.push(number);
				continue;
			}
			const n = d.number('RU');
			const key = keyOf('RU', n);
			d.insert({ ...fields, number: n, name: shortName(child.name, `C${n}`), outflows: [] }, self);
			const outflows = child.outflows.map((o) => {
				const down = d.route(o.route)?.down ?? null;
				const route = d.addRoute(key, down);
				addInflow(d, down, route);
				return { route, percent: o.percent };
			});
			d.set({ ...(d.module(key) as RunoffModule), outflows });
			d.changes.push(`New SFR child RU ${n} of RU ${at.numbers[i]}, ${areas[i]} km² of RU ${number}.`);
			pieces.push(n);
			lists[i]!.push(n);
		}
		if (!made.includes(at.outlet)) {
			d.remove(keyOfModule(child));
			d.changes.push(`SFR child RU ${number} moves wholly to the other pieces.`);
		}
		records.push({ number, areaKm2: child.areaKm2, mapMm: child.mapMm, pieces });
	}
	if (module.sfrChildren !== undefined) {
		plan.pieces.forEach((_, i) => {
			const key = keyOf('RU', at.numbers[i]!);
			d.set({ ...(d.module(key) as RunoffModule), sfrChildren: lists[i]! });
		});
	}
	return records;
}

/** Irrigation of the module being split (subdivide.md § Routes): blocks on its farm dams and blocks it owns on another piece's. Each piece with irrigation gets its own block. A block another piece owns stays whole, though it may draw from these dams (R5-E10). Returns the basis used and the new blocks, or `undefined` when there is none. */
function splitIrrigation(
	d: Draft,
	plan: SplitPlan,
	at: { damKey: Key | null; numbers: readonly number[]; outlet: number; areaShares: readonly number[]; reservoirKeys: ReadonlyMap<number, Key>; self: Key; foreign: ReadonlySet<number>; own: ReadonlySet<number> }
): { readonly basis: ShareBasis; readonly owners: readonly { readonly number: number; readonly piece: number }[]; readonly blocks: readonly IrrigationBlock[] } | undefined {
	const blocks = d.finish().modules.filter((m): m is IrrigationModule => m.kind === 'RR' && (at.own.has(m.number) || (at.damKey !== null && d.route(m.abstractionRoute)?.up === at.damKey && !at.foreign.has(m.number))));
	// Rounded as the file holds it (R5-E3): a block whose area rounds to 0 every year is left whole on the outlet,
	// with all its allocation (R5-E10).
	const live = blocks.filter((rr) => rr.areaKm2.some((row) => fileRound(row.value, IRRIGATION_DECIMALS) > 0));
	if (live.length === 0) return undefined;
	const located = plan.pieces.every((p) => p.locationShares?.irrigation !== undefined);
	const shares = located ? locationShares(plan, 'irrigation') : at.areaShares;
	const owners: { number: number; piece: number }[] = [];
	const lineage: IrrigationBlock[] = [];
	for (const rr of live) {
		const holders: number[] = [];
		const tables = splitYearTable(rr.areaKm2, shares, IRRIGATION_DECIMALS);
		// Only pieces that get a block share its allocation, or a block too small to reach one would lose that part.
		const blockShares = shares.map((s, i) => (tables[i]!.some((row) => row.value > 0) ? s : 0));
		const allocations = 'maxAllocationMm3PerYear' in rr ? largestRemainder(rr.maxAllocationMm3PerYear, blockShares, IRRIGATION_DECIMALS) : undefined;
		// Type 4's table is the allocation itself; for types 2-3 it is a growth factor on RRMA, which has been shared already (R7-I7).
		const allocationTables = 'allocation' in rr && rr.modelType === 4 ? splitYearTable(rr.allocation.values, blockShares, ALLOCATION_DECIMALS) : undefined;
		const blockSource = d.route(rr.abstractionRoute)?.up ?? null;
		const fieldsFor = (i: number) =>
			({
				...rr,
				areaKm2: tables[i]!,
				...(allocations ? { maxAllocationMm3PerYear: allocations[i]! } : {}),
				...('allocation' in rr && allocationTables ? { allocation: { ...rr.allocation, values: allocationTables[i]! } } : {}),
				...('runoffModule' in rr ? { runoffModule: at.numbers[i]! } : {})
			}) as IrrigationModule;
		plan.pieces.forEach((_, i) => {
			if (i === at.outlet || !tables[i]!.some((row) => row.value > 0)) return;
			const number = d.number('RR');
			const key = keyOf('RR', number);
			const sourceKey = at.reservoirKeys.get(i) ?? blockSource!;
			const route = d.addRoute(sourceKey, key);
			const source = d.module(sourceKey) as ReservoirModule;
			d.set({ ...source, outflows: [...source.outflows, { route, definedFlowFile: null }] });
			let returnRoute = 0;
			if (rr.returnFlowRoute) {
				const down = d.route(rr.returnFlowRoute)?.down ?? null;
				if (!takesInflow(d, down)) throw new SubdivisionError(`RR ${rr.number}'s return flow ends at ${label(down)}, where a second route can't join it`);
				returnRoute = d.addRoute(key, down);
				addInflow(d, down, returnRoute);
			}
			d.insert({ ...fieldsFor(i), number, name: shortName(rr.name, `R${number}`), abstractionRoute: route, returnFlowRoute: returnRoute }, at.reservoirKeys.get(i) ?? at.self);
			owners.push({ number, piece: at.numbers[i]! });
			holders.push(number);
			d.changes.push(`New irrigation module RR ${number} of RU ${at.numbers[i]}, drawing from ${label(sourceKey)} by route ${route}.`);
		});
		if (tables[at.outlet]!.some((row) => row.value > 0)) {
			d.set(fieldsFor(at.outlet));
			holders.unshift(rr.number);
		} else {
			d.remove(keyOfModule(rr));
			d.changes.push(`RR ${rr.number} moves wholly to the other pieces.`);
		}
		lineage.push({ number: rr.number, pieces: holders });
	}
	return { basis: located ? 'location' : 'area', owners, blocks: lineage };
}

/** Show what a plan would do. Never throws for a plan it refuses: the reason is the message. */
export const previewSplit: PreviewSplit = (bundle, plan): SplitPreview => {
	try {
		const siblings = siblingsOf(bundle, plan);
		const r = rewire(bundle, plan, [...plan.pieces.map((p) => roundMap(p.gridMapMm)), ...siblings.map((s) => s.module.mapMm)]);
		// Every check `applySplit` makes, so `refused` is absent only for a plan that can be applied.
		assertInvariants(bundle, r);
		const before = new Set(validateNetwork(bundle).map((m) => m.text));
		const after = validateNetwork({ ...bundle, network: r.network, modules: r.modules });
		return {
			pieces: plan.pieces.map((p, i) => ({ role: p.role, module: { type: 'RU', number: r.numbers[i]! }, areaKm2: r.areasKm2[i]!, outlet: i === r.outlet })),
			changes: r.changes,
			messages: [
				...(r.scaleWarning ? [r.scaleWarning] : []),
				...shareMessages(plan, r.module),
				...r.messages,
				...after.filter((m) => m.level !== 'info' && !before.has(m.text)).map((m) => m.text)
			]
		};
	} catch (error) {
		if (error instanceof SubdivisionError) return { pieces: [], changes: [], messages: [error.message], refused: error.message };
		throw error;
	}
};

/** Which share each table used, for the screen (subdivide.md § Fields). */
function shareMessages(plan: SplitPlan, module: RunoffModule): string[] {
	const out: string[] = [];
	if (module.afforestation.areaKm2.length > 0) out.push(`Afforestation is shared by ${plan.shares.afforestation}.`);
	if ((module.alienVegetation?.areaKm2.length ?? 0) > 0) out.push(`Alien vegetation is shared by ${plan.shares.alien}.`);
	return out;
}

function assertInvariants(bundle: NetworkBundle, r: Rewired): void {
	const pieces = r.numbers.map((n) => findRunoff(r.modules, n)!);
	const units = (x: number) => Math.round(fileRound(x, TABLE_DECIMALS) * 10);
	if (pieces.reduce((s, p) => s + units(p.areaKm2), 0) !== units(r.module.areaKm2)) throw new SubdivisionError(`the pieces' areas don't add up to RU ${r.module.number}'s`);
	if (pieces.some((p) => p.rainfallFile !== r.module.rainfallFile)) throw new SubdivisionError('a piece has lost the quaternary\'s rainfall file');
	for (const [name, table, tableOf] of [
		['afforestation', r.module.afforestation.areaKm2, (p: RunoffModule) => p.afforestation.areaKm2],
		['alien vegetation', r.module.alienVegetation?.areaKm2 ?? [], (p: RunoffModule) => p.alienVegetation?.areaKm2 ?? []]
	] as const) {
		table.forEach((row, k) => {
			const sum = pieces.reduce((s, p) => s + units(tableOf(p)[k]!.value), 0);
			if (sum !== units(row.value)) throw new SubdivisionError(`the pieces' ${name} doesn't add up in ${row.year}`);
		});
	}
	const errorsBefore = validateNetwork(bundle).filter((m) => m.level === 'error').length;
	const errors = validateNetwork({ ...bundle, network: r.network, modules: r.modules }).filter((m) => m.level === 'error');
	if (errors.length > errorsBefore) throw new SubdivisionError(`the split would break the network: ${errors.map((m) => m.text).join('; ')}`);
}

/** Piece role as the sidecar names it. */
function pieceRecords(plan: SplitPlan, r: Rewired, maps: readonly number[], replacing?: SubdivisionPiece): SubdivisionPiece[] {
	return plan.pieces.map((p, i) => ({
		role: i === r.outlet ? (replacing && replacing.role !== 'outlet' ? replacing.role : 'outlet') : p.role,
		number: r.numbers[i]!,
		polygonKm2: p.polygonKm2,
		areaKm2: r.areasKm2[i]!,
		gridMapMm: p.gridMapMm,
		mapMm: maps[i]!,
		mapSource: p.mapSource
	}));
}

function sidecarEntry(bundle: NetworkBundle, plan: SplitPlan, r: Rewired, options: ApplySplitOptions): Subdivision {
	const { calibration } = options;
	const previous = subdivisionOf(bundle, plan.quaternary);
	const maps = calibration.finalMapsMm;
	const replacing = previous?.pieces.find((p) => p.number === plan.module.number);
	const planned = pieceRecords(plan, r, maps, replacing);
	const others = previous?.pieces.filter((p) => p !== replacing) ?? [];
	const updated = others.map((p, k) => ({ ...p, mapMm: maps[plan.pieces.length + k]! }));
	const position = previous && replacing ? previous.pieces.indexOf(replacing) : 0;
	const pieces = [...updated.slice(0, position), ...planned, ...updated.slice(position)];
	const children = mergeChildRecords(previous?.children ?? [], r.children);
	const hgrad = r.module.sami?.maxHydraulicGradient;
	const shares = { ...plan.shares, ...(r.irrigation ? { irrigation: r.irrigation } : {}) };
	const remaining = new Set(r.modules.filter((m) => m.kind === 'RR').map((m) => m.number));
	const irrigation = [...(previous?.irrigation ?? []), ...r.irrigationOwners].filter((o) => remaining.has(o.number));
	return {
		method: 'subdivide-1',
		module: previous?.module ?? { type: 'RU', number: r.module.number, areaKm2: r.module.areaKm2, mapMm: r.module.mapMm, ...(hgrad !== undefined ? { maxHydraulicGradient: hgrad } : {}) },
		splits: [...(previous?.splits ?? []), ...plan.splits],
		pieces,
		...(children.length > 0 ? { children } : {}),
		grid: previous?.grid ?? plan.grid,
		calibration: {
			target: options.target,
			crossCheck: options.crossCheck,
			period: [calibration.period.startYear, calibration.period.endYear],
			status: calibration.status === 'converged' ? 'converged' : 'not_converged',
			...(calibration.status === 'converged' ? {} : { acceptedNotConverged: true as const }),
			factor: calibration.best!.s,
			finalMarMm3: calibration.finalMarMm3!,
			iterations: calibration.iterations
		},
		shares: previous?.shares ?? shares,
		...(previous ? { laterShares: [...(previous.laterShares ?? []), shares] } : {}),
		...(irrigation.length > 0 ? { irrigation } : {}),
		farmDamPercent: 'original'
	};
}

/** A child split again is a piece of the child the first split recorded. */
function mergeChildRecords(previous: readonly SubdivisionChild[], latest: readonly SubdivisionChild[]): SubdivisionChild[] {
	const out = [...previous];
	for (const record of latest) {
		const k = out.findIndex((c) => c.pieces.includes(record.number));
		if (k < 0) out.push(record);
		else out[k] = { ...out[k]!, pieces: [...out[k]!.pieces.filter((n) => n !== record.number), ...record.pieces] };
	}
	return out;
}

/** A located dam of the split module now belongs to the piece it lies in. */
function repointDam(dam: DamRecord, plan: SplitPlan, r: Rewired): DamRecord {
	if (dam.module?.type !== 'RU' || dam.module.number !== plan.module.number) return dam;
	const i = plan.pieces.findIndex((p) => pointInGeometry([dam.lon, dam.lat], p.geometry));
	return i < 0 ? dam : { ...dam, module: { type: 'RU', number: r.numbers[i]! } };
}

/** Each module the split divided, and what it became. */
function lineageOf(r: Rewired): SplitLineage[] {
	const refs = (type: ModuleTypeCode, numbers: readonly number[]) => numbers.map((number) => ({ type, number }));
	return [
		{ kind: 'runoff', from: { type: 'RU', number: r.module.number }, pieces: refs('RU', r.numbers) },
		...r.children.map((c): SplitLineage => ({ kind: 'child', from: { type: 'RU', number: c.number }, pieces: refs('RU', c.pieces) })),
		...(r.reservoirs ? [{ kind: 'reservoir' as const, from: { type: 'RV' as const, number: r.reservoirs.number }, pieces: refs('RV', r.reservoirs.pieces) }] : []),
		...r.irrigationBlocks.map((b): SplitLineage => ({ kind: 'irrigation', from: { type: 'RR', number: b.number }, pieces: refs('RR', b.pieces) }))
	];
}

/**
 * The bundle with the module split and rewired and the sidecar's
 * `subdivisions` entry written, each note in `values` following its value
 * (R7-C14). Throws with a plain-language message if the
 * calibration didn't converge and the user didn't accept it, or if an
 * invariant fails: nothing unconverged is applied silently.
 */
export function applySplit<B extends NetworkBundle>(bundle: B, plan: SplitPlan, options: ApplySplitOptions): B {
	const { calibration, target } = options;
	if (calibration.status === 'refused' || !calibration.best || calibration.finalMarMm3 === null) throw new SubdivisionError(calibration.message ?? 'the calibration was refused, so there is nothing to apply');
	if (calibration.status === 'not_converged' && !options.acceptNotConverged) {
		throw new SubdivisionError(`the calibration did not converge (${calibration.message ?? 'no factor found'}): use the best factor, change the target or cancel`);
	}
	const { best } = calibration;
	const logged = ((best.marMm3 - target.marMm3) / target.marMm3) * 100;
	if (Math.abs(logged - best.errorPct) > 1e-6) throw new SubdivisionError('this calibration was made for another target: calibrate again');
	const off = Math.abs(calibration.finalMarMm3 - target.marMm3) / target.marMm3;
	if (calibration.status === 'converged' && !(off <= MAR_TOLERANCE)) throw new SubdivisionError('as saved, this calibration is more than 2 % from the target: calibrate again');
	const siblings = siblingsOf(bundle, plan);
	const maps = calibration.finalMapsMm;
	if (maps.length !== plan.pieces.length + siblings.length) throw new SubdivisionError(`the calibration has ${maps.length} MAPs for ${plan.pieces.length + siblings.length} pieces: calibrate this plan again`);
	const grid = [...plan.pieces.map((p) => p.gridMapMm), ...siblings.map((s) => s.gridMapMm)];
	maps.forEach((map, i) => {
		const exact = best.s * grid[i]!;
		if (Math.abs(map - exact) > 0.5 + 1e-6) throw new SubdivisionError('the final MAPs don\'t match the calibration\'s factor: calibrate again');
	});
	// The areas came from the plan and the MAPs from the calibration: a boundary moved in between must not pass as converged.
	const saved = planNaturalMar(bundle, plan, maps);
	if (Math.abs(saved - calibration.finalMarMm3) > 1e-9 * Math.max(1, saved)) throw new SubdivisionError('this calibration was made for another plan: calibrate again');
	const r = rewire(bundle, plan, calibration.finalMapsMm);
	assertInvariants(bundle, r);
	const sidecar: Sidecar = {
		schema: 'pitman-sidecar',
		schemaVersion: 1,
		...bundle.sidecar,
		subdivisions: { ...bundle.sidecar?.subdivisions, [plan.quaternary]: sidecarEntry(bundle, plan, r, options) },
		...(bundle.sidecar?.dams ? { dams: bundle.sidecar.dams.map((dam) => repointDam(dam, plan, r)) } : {}),
		...(bundle.sidecar?.values
			? {
					values: carryValues(bundle.sidecar.values, {
						quaternary: plan.quaternary,
						before: bundle.modules,
						after: r,
						lineage: lineageOf(r),
						rescaled: siblings.flatMap(({ module }) => [module.number, ...(module.sfrChildren ?? [])]).map((number) => ({ type: 'RU' as const, number }))
					})
				}
			: {})
	};
	return { ...bundle, network: r.network, modules: r.modules, sidecar };
}

/** Year tables added back together, to the file's precision. */
function sumTables(tables: readonly YearTable[], decimals: number): YearTable {
	const first = tables[0] ?? [];
	return first.map((row, k) => ({ year: row.year, value: fileRound(tables.reduce((s, t) => s + (t[k]?.value ?? 0), 0), decimals) }));
}

function mergeRunoff(pieces: readonly RunoffModule[], base: RunoffModule, areaKm2: number, mapMm: number): RunoffModule {
	const merged = withLandUse(
		base,
		sumTables(pieces.map((p) => p.afforestation.areaKm2), TABLE_DECIMALS),
		base.alienVegetation ? sumTables(pieces.map((p) => p.alienVegetation?.areaKm2 ?? []), TABLE_DECIMALS) : undefined
	);
	return { ...merged, areaKm2, mapMm };
}

/**
 * The inverse of a split, for one quaternary: the original module's fields
 * back from its pieces (invariant 8), and each SFR child's. The network
 * around them isn't rebuilt: the user's saved zip is the undo.
 */
export function mergePieces(bundle: NetworkBundle, quaternary: string): { readonly module: RunoffModule; readonly children: readonly RunoffModule[] } {
	const entry = subdivisionOf(bundle, quaternary);
	if (!entry) throw new SubdivisionError(`${quaternary} isn't sub-divided`);
	const pieces = entry.pieces.map((p) => findRunoff(bundle.modules, p.number));
	if (pieces.some((p) => !p)) throw new SubdivisionError(`a piece of ${quaternary} is missing from the network`);
	const modules = pieces as RunoffModule[];
	const outlet = modules.find((m) => m.number === entry.module.number);
	if (!outlet) throw new SubdivisionError(`the outlet piece of ${quaternary} is missing from the network`);
	let module = mergeRunoff(modules, outlet, entry.module.areaKm2, entry.module.mapMm);
	if (outlet.sami) {
		module = {
			...module,
			sami: {
				...outlet.sami,
				gwEvaporationArea: fileRound(modules.reduce((s, m) => s + (m.sami?.gwEvaporationArea ?? 0), 0), 2),
				maxHydraulicGradient: entry.module.maxHydraulicGradient ?? outlet.sami.maxHydraulicGradient,
				abstractions: sumTables(modules.map((m) => m.sami?.abstractions ?? []), 3)
			}
		};
	}
	if (outlet.hughes) {
		const total = (pick: (m: RunoffModule) => number) => fileRound(modules.reduce((s, m) => s + pick(m), 0), 2);
		module = {
			...module,
			hughes: {
				...outlet.hughes,
				upperAbstraction: { ...outlet.hughes.upperAbstraction, annual: total((m) => m.hughes?.upperAbstraction.annual ?? 0) },
				riparianAbstraction: { ...outlet.hughes.riparianAbstraction, annual: total((m) => m.hughes?.riparianAbstraction.annual ?? 0) }
			}
		};
	}
	const children = (entry.children ?? []).map((c) => {
		const parts = c.pieces.map((n) => findRunoff(bundle.modules, n)).filter((m): m is RunoffModule => m !== undefined);
		const base = parts.find((m) => m.number === c.number) ?? parts[0];
		if (!base) throw new SubdivisionError(`SFR child RU ${c.number} of ${quaternary} is missing from the network`);
		return { ...mergeRunoff(parts, base, c.areaKm2, c.mapMm), number: c.number };
	});
	if (entry.children) module = { ...module, sfrChildren: entry.children.map((c) => c.number) };
	// A piece that joined through the outlet's inflow route (R5-E5): the original had none, or the join would have been refused.
	const inflow = bundle.network.routes.find((r) => r.number === outlet.inflowRoute);
	const from = inflow ? bundle.network.modules[inflow.upstreamPosition - 1] : undefined;
	if (from?.type === 'RU' && entry.pieces.some((p) => p.number === from.number)) module = { ...module, inflowRoute: 0 };
	return { module, children };
}
