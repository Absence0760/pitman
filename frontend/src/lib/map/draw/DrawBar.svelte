<!--
	Ported from IC-WBT (Absence0760/project-water-management, MIT)
	frontend/src/lib/components/map/draw/DrawBar.svelte at f888e4461, stripped to
	one polygon. The paste form is inline here rather than IC-WBT's sheet.

	The draw bar: under the map while `tool` is `draw`. It says what to do, names
	the last change (a polite live region), and holds the buttons the keys and
	clicks also reach: Undo, Finish, Use this shape, Clear, and the way in that
	needs no pointer, Paste a shape. Escape anywhere in the bar clears (asking
	once when a drawing would be lost: Draft.escape); Clear drops it at once.
-->
<script lang="ts">
	import type { AreaGeometry } from '@pitman/wrsm';
	import type { Draft } from './draft.svelte.js';
	import { parseShape } from './parseShape.js';
	import { draftProblem } from './shape.js';

	let {
		draft,
		mapReady,
		onuse
	}: {
		draft: Draft;
		/** false without WebGL: no clicks to place, so the bar leads with pasting. */
		mapReady: boolean;
		onuse: (geometry: AreaGeometry) => void;
	} = $props();

	const uid = $props.id();
	let pasting = $state(false);
	let pasted = $state('');
	let pasteError = $state<string | null>(null);

	const problem = $derived(draft.whole ? null : draft.phase === 'review' ? draftProblem(draft.coords) : null);
	const canSnap = $derived(!draft.whole && mapReady && draft.snapTargets.length > 0);
	const phone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	const click = phone ? 'Tap' : 'Click';
	const howTo = $derived.by(() => {
		if (!mapReady) return 'The map can’t be drawn here: paste the shape as GeoJSON or WKT.';
		if (draft.whole) return 'A pasted shape of several parts: use it as it is, or paste another.';
		if (draft.phase === 'drawing') return `${click} to add each corner; ${click.toLowerCase()} the first one (or Finish) to close the shape.`;
		return `Drag a corner to move it, ${click.toLowerCase()} an edge’s middle to add one, pick a corner and press Delete to remove it.`;
	});

	function usePaste() {
		const r = parseShape(pasted);
		if ('error' in r) {
			pasteError = r.error;
			return;
		}
		pasteError = null;
		pasting = false;
		pasted = '';
		draft.replace(r.geometry);
	}

	function use() {
		const g = draft.geometry;
		if (g && !problem) onuse(g);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		if (pasting) pasting = false;
		else draft.escape();
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape clears from any control inside; each control is itself interactive) -->
<section class="draw-bar" aria-labelledby="{uid}-h" data-phase={draft.phase} {onkeydown}>
	<h3 id="{uid}-h">Drawing an area</h3>
	<p class="how" data-testid="map-draw-how">{howTo}</p>
	<p class="note said" role="status" data-testid="map-draw-said">{draft.said}</p>
	{#if canSnap}
		<div class="snap">
			<label title={phone ? undefined : 'Hold Alt to place one corner exactly.'}><input type="checkbox" bind:checked={draft.snapOn} /> Snap to outlines</label>
			{#if draft.phase === 'drawing'}<label><input type="checkbox" bind:checked={draft.follow} disabled={!draft.snapOn} /> Follow edges</label>{/if}
		</div>
	{/if}
	{#if problem}<p class="error" data-testid="map-draw-problem">{problem}</p>{/if}
	{#if pasting}
		<div class="paste">
			<label for="{uid}-paste">GeoJSON or WKT, in WGS84 longitude and latitude</label>
			<textarea id="{uid}-paste" rows="4" bind:value={pasted} aria-invalid={pasteError ? 'true' : undefined} aria-describedby={pasteError ? `${uid}-paste-error` : undefined}></textarea>
			{#if pasteError}<p class="error" id="{uid}-paste-error" role="alert">{pasteError}</p>{/if}
			<div class="row">
				<button type="button" class="primary" onclick={usePaste}>Use the pasted shape</button>
				<button type="button" onclick={() => (pasting = false)}>Close</button>
			</div>
		</div>
	{/if}
	<div class="row">
		{#if !pasting}<button type="button" onclick={() => (pasting = true)}>Paste a shape</button>{/if}
		<button type="button" onclick={() => draft.undo()} disabled={!draft.canUndo}>Undo</button>
		{#if draft.phase === 'drawing'}
			<button type="button" onclick={() => draft.finish()} disabled={!draft.canFinish}>Finish</button>
		{/if}
		{#if draft.phase === 'review' && draft.corner !== null}
			<button type="button" onclick={() => draft.corner !== null && draft.removeCorner(draft.corner)}>Remove the picked corner</button>
		{/if}
		<button type="button" onclick={() => draft.clear()}>Clear</button>
		{#if draft.phase === 'review'}
			<button type="button" class="primary" onclick={use} disabled={!!problem || !draft.geometry}>Use this shape</button>
		{/if}
	</div>
</section>

<style>
	.draw-bar {
		display: grid;
		gap: 0.3rem;
		margin-top: 0.5rem;
		padding: 0.5rem 0.75rem 0.75rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
	}
	h3 {
		margin: 0;
	}
	.how,
	.said,
	.error {
		margin: 0;
	}
	.how {
		font-size: var(--font-sm);
	}
	/* Always there, so a screen reader hears it; empty until something has happened. */
	.said:empty {
		display: none;
	}
	.snap,
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.9rem;
		align-items: center;
		font-size: var(--font-sm);
	}
	.row {
		gap: 0.4rem;
		font-size: inherit;
	}
	.snap label {
		display: inline-flex;
		gap: 0.3rem;
		align-items: center;
	}
	.paste {
		display: grid;
		gap: 0.3rem;
		font-size: var(--font-sm);
	}
	textarea {
		font-family: var(--font-mono);
		font-size: var(--font-sm);
		width: 100%;
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
	}
</style>
