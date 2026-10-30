// Copied from IC-WBT backend/src/delineation/outline.ts at f888e4461 (MIT, same author).
// The outline of a catchment's cells as one polygon ring (docs/design/
// delineation.md § The polygon): traced along the cells' edges, kept as one
// piece where cells touch only at a corner (D8 joins them), simplified with
// Douglas–Peucker, in grid coordinates (x right, y down, a cell is 1 × 1).
// delineate.ts turns the vertices into longitude and latitude.

export type Pt = [number, number];

/** How far off a corner the ring passes where two cells touch only there, so it never touches itself. */
const CHAMFER = 0.25;

/**
 * The outer ring of the mask's cells, region on the left walking it in grid
 * coordinates (y down), closed (last = first), corners only. Holes and any
 * other separate piece are dropped (the largest ring wins): a catchment
 * surrounds nothing that drains elsewhere, bar D8's diagonal crossings, a few
 * cells at most.
 */
export function traceOutline(nx: number, ny: number, mask: Uint8Array): Pt[] {
	let best: Pt[] = [];
	let bestArea = 0;
	for (const ring of traceAll(nx, ny, mask)) {
		const area = Math.abs(signedArea(ring));
		if (area > bestArea) {
			bestArea = area;
			best = ring;
		}
	}
	return best;
}

/**
 * The mask's outer ring (as traceOutline) and its holes: the rings walked the
 * other way round, lying inside it, of at least `minHoleCells` cells. A unit's
 * own piece of a catchment has real holes, where a unit upstream lies wholly
 * inside it (design/start-from-map.md § Sub-catchments); a hole of a cell or
 * two is D8's diagonal crossings, dropped as traceOutline drops them.
 */
export function traceRings(nx: number, ny: number, mask: Uint8Array, minHoleCells = 4): { outer: Pt[]; holes: Pt[][] } {
	const rings = traceAll(nx, ny, mask);
	let outer: Pt[] = [];
	let outerArea = 0;
	for (const ring of rings) {
		const a = signedArea(ring);
		if (Math.abs(a) > Math.abs(outerArea)) {
			outerArea = a;
			outer = ring;
		}
	}
	const holes = rings.filter((r) => r !== outer && Math.sign(signedArea(r)) === -Math.sign(outerArea) && Math.abs(signedArea(r)) >= minHoleCells && insideRing(r[0]!, outer));
	return { outer, holes };
}

/** Whether p lies inside the closed ring (even–odd; a vertex of a hole is never on its outer ring, so ties don't arise). */
export function insideRing(p: Pt, ring: readonly Pt[]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
		const [xi, yi] = ring[i]!;
		const [xj, yj] = ring[j]!;
		if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** Every closed ring of the mask's cell edges, region on the left (y down), corners only. */
function traceAll(nx: number, ny: number, mask: Uint8Array): Pt[][] {
	const W = nx + 1;
	const out = new Map<number, number[]>();
	const add = (ax: number, ay: number, bx: number, by: number) => {
		const a = ay * W + ax;
		const b = by * W + bx;
		const list = out.get(a);
		if (list) list.push(b);
		else out.set(a, [b]);
	};
	const at = (x: number, y: number) => x >= 0 && y >= 0 && x < nx && y < ny && mask[y * nx + x] === 1;
	for (let y = 0; y < ny; y++) {
		for (let x = 0; x < nx; x++) {
			if (!at(x, y)) continue;
			if (!at(x, y - 1)) add(x + 1, y, x, y); // top, heading west
			if (!at(x - 1, y)) add(x, y, x, y + 1); // left, heading south
			if (!at(x, y + 1)) add(x, y + 1, x + 1, y + 1); // bottom, heading east
			if (!at(x + 1, y)) add(x + 1, y + 1, x + 1, y); // right, heading north
		}
	}
	const saddles = new Set<number>();
	for (const [v, list] of out) if (list.length > 1) saddles.add(v);
	const starts = [...out.keys()].filter((v) => !saddles.has(v));
	const rings: Pt[][] = [];
	for (const start of starts) {
		if (!out.has(start)) continue;
		const ring: Pt[] = [];
		let v = start;
		let dx = 0;
		let dy = 0;
		for (let guard = 0; ; guard++) {
			const list = out.get(v);
			if (!list || guard > 4 * nx * ny + 8) break;
			const vx = v % W;
			const vy = (v - vx) / W;
			let k = 0;
			if (list.length > 1) {
				// A saddle: turn right (region on the left), which carries the ring on to the cell that touches at the corner.
				k = list.findIndex((w) => (w % W) - vx === -dy && Math.floor(w / W) - vy === dx);
				if (k < 0) k = 0;
			}
			const w = list.splice(k, 1)[0]!;
			if (list.length === 0) out.delete(v);
			const ndx = (w % W) - vx;
			const ndy = Math.floor(w / W) - vy;
			if (saddles.has(v)) {
				ring.push([vx - CHAMFER * dx, vy - CHAMFER * dy], [vx + CHAMFER * ndx, vy + CHAMFER * ndy]);
			} else if (v === start || ndx !== dx || ndy !== dy) ring.push([vx, vy]);
			dx = ndx;
			dy = ndy;
			v = w;
			if (v === start) break;
		}
		// The start vertex may sit mid-edge: drop it when the ring runs straight through it.
		if (ring.length > 2) {
			const a = ring[ring.length - 1]!;
			const b = ring[0]!;
			const c = ring[1]!;
			if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) === 0) ring.shift();
		}
		if (ring.length < 3) continue;
		ring.push([ring[0]![0], ring[0]![1]]);
		rings.push(ring);
	}
	return rings;
}

/** Shoelace area of a closed ring (grid units; positive when the region is on the left in y-down coordinates walked as traced… sign only matters relatively). */
export function signedArea(ring: readonly Pt[]): number {
	let s = 0;
	for (let i = 0; i + 1 < ring.length; i++) s += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
	return s / 2;
}

function segDist2(p: Pt, a: Pt, b: Pt): number {
	const vx = b[0] - a[0];
	const vy = b[1] - a[1];
	const len2 = vx * vx + vy * vy;
	let t = len2 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const dx = a[0] + t * vx - p[0];
	const dy = a[1] + t * vy - p[1];
	return dx * dx + dy * dy;
}

/** Douglas–Peucker on an open polyline: the kept indices' flags. */
function dpKeep(pts: readonly Pt[], from: number, to: number, tol2: number, keep: Uint8Array) {
	const stack: [number, number][] = [[from, to]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		let far = -1;
		let farD = tol2;
		for (let i = a + 1; i < b; i++) {
			const d = segDist2(pts[i]!, pts[a]!, pts[b]!);
			if (d > farD) {
				farD = d;
				far = i;
			}
		}
		if (far >= 0) {
			keep[far] = 1;
			stack.push([a, far], [far, b]);
		}
	}
}

/**
 * A closed ring simplified with Douglas–Peucker at `tol` grid units, split at
 * the vertex farthest from the first so the closing stretch is simplified
 * too. Keeps at least four positions (a triangle, closed).
 */
export function simplifyRing(ring: readonly Pt[], tol: number): Pt[] {
	const n = ring.length - 1; // distinct vertices
	if (n <= 3 || tol <= 0) return ring.map((p) => [p[0], p[1]]);
	let far = 1;
	let farD = -1;
	for (let i = 1; i < n; i++) {
		const d = (ring[i]![0] - ring[0]![0]) ** 2 + (ring[i]![1] - ring[0]![1]) ** 2;
		if (d > farD) {
			farD = d;
			far = i;
		}
	}
	const keep = new Uint8Array(n + 1);
	keep[0] = keep[far] = keep[n] = 1;
	dpKeep(ring, 0, far, tol * tol, keep);
	dpKeep(ring, far, n, tol * tol, keep);
	const outRing = ring.filter((_, i) => keep[i]).map((p) => [p[0], p[1]] as Pt);
	return outRing.length >= 4 ? outRing : ring.map((p) => [p[0], p[1]]);
}

/** An open polyline simplified with Douglas–Peucker at `tol` grid units; its ends are always kept. */
export function simplifyLine(line: readonly Pt[], tol: number): Pt[] {
	if (line.length <= 2 || tol <= 0) return line.map((p) => [p[0], p[1]]);
	const keep = new Uint8Array(line.length);
	keep[0] = keep[line.length - 1] = 1;
	dpKeep(line, 0, line.length - 1, tol * tol, keep);
	return line.filter((_, i) => keep[i]).map((p) => [p[0], p[1]] as Pt);
}
