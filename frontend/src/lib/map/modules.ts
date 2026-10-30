// A network's modules placed on the map: a module sits in the quaternary its
// name holds. WRSM2000 stores no coordinates, so a name with no code the
// boundaries know can't be placed, and the panel says how many. Pure, so vitest
// checks it.
import type { QuaternaryFeature } from '@pitman/wrsm';
import type { MapModule } from './contract.js';
import { boxOf, interiorPoint, type Position } from './pieces.js';

/** What a module needs to be placed: a parsed one's `kind`, or an unparsed one's `moduleType`. */
export interface ModuleLike {
	readonly kind: string;
	readonly moduleType?: string;
	readonly number: number;
	readonly name: string;
}

export interface Placement {
	readonly placed: readonly MapModule[];
	/** The ones with no code the boundaries know, for the list. */
	readonly unplaced: readonly { readonly id: string; readonly label: string }[];
}

/** A quaternary code on its own in a name: a letter, two digits, a letter; `H10F`, `H10F-2`, `h10f upper`, `UP_H10F`, `H10F1`. Case folded. */
const CODE = /(?<![A-Z0-9])[A-Z]\d{2}[A-Z](?![A-Z])/g;

/** The first code in `name` that the boundaries know, else null. */
export function quaternaryCodeIn(name: string, known: ReadonlySet<string>): string | null {
	for (const m of name.toUpperCase().matchAll(CODE)) if (known.has(m[0])) return m[0];
	return null;
}

/**
 * The k-th of n modules on a ring round a point inside the quaternary, as a
 * share of its smaller side: at one point they would hide each other, and the
 * code written there. A wider ring for more of them.
 */
function spread(at: Position, side: number, k: number, n: number): Position {
	const angle = (2 * Math.PI * k) / n;
	const radius = side * Math.min(0.35, 0.15 + 0.02 * n);
	return [at[0] + radius * Math.cos(angle), at[1] + radius * Math.sin(angle)];
}

/** Every module on a quaternary its name holds, or listed as not placed. `RU3` style ids, the name beside it in the label. */
export function placeModules(modules: readonly ModuleLike[], quaternaries: readonly QuaternaryFeature[]): Placement {
	const byCode = new Map(quaternaries.map((q) => [q.properties.code, q]));
	const known = new Set(byCode.keys());
	const groups = new Map<string, { id: string; label: string }[]>();
	const unplaced: { id: string; label: string }[] = [];
	for (const m of modules) {
		const id = `${m.moduleType ?? m.kind}${m.number}`;
		const label = m.name.trim() ? `${id} ${m.name.trim()}` : id;
		const code = quaternaryCodeIn(m.name, known);
		if (code === null) unplaced.push({ id, label });
		else groups.set(code, [...(groups.get(code) ?? []), { id, label }]);
	}
	const placed: MapModule[] = [];
	for (const [code, group] of groups) {
		const geometry = byCode.get(code)!.geometry;
		const at = interiorPoint(geometry);
		const box = boxOf(geometry);
		if (!at || !box) {
			unplaced.push(...group);
			continue;
		}
		const side = Math.min(box[2] - box[0], box[3] - box[1]);
		group.forEach((m, k) => placed.push({ ...m, lngLat: spread(at, side, k, group.length) }));
	}
	return { placed, unplaced };
}
