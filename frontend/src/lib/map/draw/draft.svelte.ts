// Ported from IC-WBT (Absence0760/project-water-management, MIT) frontend/src/lib/components/map/draw/draft.svelte.ts at f888e4461,
// stripped to one polygon: no feature kinds, edits, splits, traces, measures or confirm dialog.
//
// The shape being drawn. One instance per map: Map.svelte draws it and turns
// clicks, drags and keys into the calls below; DrawBar.svelte shows what it is
// and offers Undo, Finish, Use this shape and Clear. Nothing leaves the map
// until "Use this shape". Every change goes on an undo stack.
import type { AreaGeometry } from '@pitman/wrsm';
import type { Position } from '../pieces.js';
import { canFinish, distinctCorners, editableCorners, geometryOf, withoutCorner } from './shape.js';
import { sameLine, type SnapHit, type SnapLine, traceAlong } from './snap.js';

/** The most changes Undo keeps. */
const UNDO_MAX = 200;

const positionText = (p: Position) => `${Math.abs(p[1]).toFixed(5)}° ${p[1] < 0 ? 'S' : 'N'}, ${Math.abs(p[0]).toFixed(5)}° ${p[0] < 0 ? 'W' : 'E'}`;

export class Draft {
	/** Whether the map is in drawing mode. */
	active = $state(false);
	/** The corners, not closed (geometryOf closes the ring). */
	coords = $state.raw<Position[]>([]);
	/** drawing: corners are being added; review: the shape is closed and can be adjusted, then used. */
	phase = $state<'drawing' | 'review'>('drawing');
	/** A pasted shape of several parts (or with holes): used whole, not editable corner by corner. */
	whole = $state.raw<AreaGeometry | null>(null);
	/** The picked corner (review), for Delete. */
	corner = $state<number | null>(null);
	/** Where the pointer is while drawing, for the line to it. */
	cursor = $state.raw<Position | null>(null);
	/** The last thing that happened, for a polite live region. */
	said = $state('');
	/** Snap corners to the quaternaries' and pieces' corners and edges; off in the bar, or for one click with Alt held. */
	snapOn = $state(true);
	/** Two corners in a row on one outline take the corners between them along it. */
	follow = $state(true);
	/** The outlines a corner can snap to. */
	snapTargets = $state.raw<readonly SnapLine[]>([]);
	/** Where the pointer would snap now (drawn as a ring), or null. */
	snapHint = $state.raw<SnapHit | null>(null);
	#escaped = false;
	/** Each corner's snap hit while drawing (parallel to coords), for Follow edges. */
	#hits: (SnapHit | null)[] = [];
	#undo = $state.raw<{ coords: Position[]; phase: 'drawing' | 'review'; whole: AreaGeometry | null; hits: (SnapHit | null)[] }[]>([]);

	get canUndo() {
		return this.#undo.length > 0;
	}
	/** What "Use this shape" hands over: the pasted whole shape, else the corners' polygon (null while too few). */
	get geometry(): AreaGeometry | null {
		return this.whole ?? geometryOf(this.coords);
	}
	get canFinish() {
		return this.phase === 'drawing' && canFinish(this.coords);
	}
	/** Work Escape mustn't drop at one press: a finished or pasted shape, or two corners or more. A single corner is one click to make again. */
	get unsaved() {
		return this.active && (this.whole !== null || this.phase === 'review' || this.coords.length >= 2);
	}

	#reset() {
		this.coords = [];
		this.phase = 'drawing';
		this.whole = null;
		this.corner = null;
		this.cursor = null;
		this.#undo = [];
		this.#hits = [];
		this.#escaped = false;
		this.snapHint = null;
		this.said = '';
	}

	#record() {
		this.#escaped = false;
		this.#undo = [...this.#undo.slice(-(UNDO_MAX - 1)), { coords: this.coords, phase: this.phase, whole: this.whole, hits: [...this.#hits] }];
	}

	/** Start a new drawing. */
	start() {
		this.#reset();
		this.active = true;
	}

	/** Drop the drawing and leave drawing mode. */
	stop() {
		this.#reset();
		this.active = false;
	}

	/** Clear the drawing and stay in drawing mode. */
	clear() {
		this.#reset();
		this.said = 'Cleared; nothing drawn yet.';
	}

	/** Escape: clears at once when nothing would be lost, else the first press says so and the second clears. */
	escape() {
		if (!this.active) return;
		if (this.unsaved && !this.#escaped) {
			this.#escaped = true;
			this.said = 'Press Escape again to discard this drawing.';
			return;
		}
		this.clear();
	}

	get #following() {
		return this.follow && this.snapOn;
	}

	/** A click or Enter while drawing: a corner. `hit` is where it snapped, when it did. */
	add(p: Position, hit: SnapHit | null = null) {
		if (this.phase !== 'drawing') return;
		this.#record();
		const last = this.#hits.at(-1) ?? null;
		const along = this.#following && hit && this.coords.length && sameLine(last, hit) ? traceAlong(hit.line, last!.pos, hit.pos, this.coords.at(-1)!, p) : [];
		this.coords = [...this.coords, ...along, p];
		this.#hits = [...this.#hits, ...along.map(() => null), hit];
		const on = hit ? `, on ${hit.line.label}’s ${hit.what}` : '';
		const followed = along.length ? ` (${along.length} ${along.length === 1 ? 'corner' : 'corners'} followed along it)` : '';
		this.said = `Corner ${this.coords.length} at ${positionText(p)}${on}${followed}.`;
	}

	/** Close the polygon: it is drawn, and can be adjusted and used. */
	finish(): boolean {
		if (!this.canFinish) return false;
		this.#record();
		// Closing a polygon whose first and last corners sit on one outline follows it too.
		const first = this.#hits[0] ?? null;
		const last = this.#hits.at(-1) ?? null;
		if (this.#following && this.coords.length >= 3 && sameLine(last, first) && last !== first) {
			this.coords = [...this.coords, ...traceAlong(last!.line, last!.pos, first!.pos, this.coords.at(-1)!, this.coords[0]!)];
		}
		this.#hits = [];
		this.coords = distinctCorners(this.coords);
		this.phase = 'review';
		this.cursor = null;
		this.said = `Shape closed with ${this.coords.length} corners. Drag a corner to adjust it, then use it.`;
		return true;
	}

	/** Before a drag: one undo step for the whole drag. */
	beginChange() {
		this.#record();
	}

	/** Move corner i (during a drag; the undo step was taken by beginChange). */
	moveCorner(i: number, p: Position) {
		if (i < 0 || i >= this.coords.length) return;
		this.coords = this.coords.map((c, k) => (k === i ? p : c));
	}

	/** Add a corner after corner `after` (a click on an edge's middle). */
	insertCorner(after: number, p: Position) {
		this.#record();
		this.coords = [...this.coords.slice(0, after + 1), p, ...this.coords.slice(after + 1)];
		this.corner = after + 1;
		this.said = `Corner added; the shape has ${this.coords.length} corners.`;
	}

	/** Remove corner i, unless the shape would have too few. */
	removeCorner(i: number): boolean {
		const next = withoutCorner(this.coords, i);
		if (!next) {
			this.said = 'A shape keeps at least 3 corners.';
			return false;
		}
		this.#record();
		this.coords = next;
		this.corner = null;
		this.said = `Corner removed; ${this.coords.length} left.`;
		return true;
	}

	/** A pasted shape replaces the draft: editable when it has one part, else kept whole. */
	replace(g: AreaGeometry) {
		this.#record();
		const corners = editableCorners(g);
		this.coords = corners ?? [];
		this.whole = corners ? null : g;
		this.#hits = [];
		this.phase = 'review';
		this.corner = null;
		this.cursor = null;
		this.said = corners ? `Pasted: ${this.coords.length} corners.` : 'Pasted a shape of several parts.';
	}

	/** Undo the last change (while drawing: the last corner). */
	undo() {
		const last = this.#undo.at(-1);
		if (!last) return;
		this.#undo = this.#undo.slice(0, -1);
		this.coords = last.coords;
		this.phase = last.phase;
		this.whole = last.whole;
		this.#hits = last.hits;
		this.corner = null;
		this.said = this.coords.length ? `Undone; ${this.coords.length} ${this.coords.length === 1 ? 'corner' : 'corners'}.` : 'Undone; nothing drawn yet.';
	}
}
