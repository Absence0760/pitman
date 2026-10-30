<!--
	The Map step. It answers one question first: which quaternary are you
	working in? Pick it on the map or by its code (the list does everything the
	map does); the tiles under the map give its area and MAP and where each came
	from (issue #3 rule 8). The MAP-grid layer is one tick. The network's modules
	sit in the quaternaries their names hold, and the panel says how many
	couldn't be placed, and which.

	When there are no boundaries (production until D-1 is settled, docs/data.md
	§ Quaternaries) it says so plainly and how to go on; the map itself still works.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { onMount } from 'svelte';
	import type { MapGridCells, NetworkBundle, QuaternaryCollection } from '@pitman/wrsm';
	import { API_BASE_URL } from '#lib/extend/api-base.js';
	import { formatNumber } from '#lib/results/format.js';
	import { fetchMapGridCells, fetchQuaternaries, MapRequestError } from './api.js';
	import Map from './Map.svelte';
	import { mapGridStride, MAP_GRID_MAX_DRAWN, MAP_RAMP_MM } from './mapStyle.js';
	import { placeModules } from './modules.js';
	import type { Box } from './pieces.js';
	import { boxHolds, MAP_GRID_BBOX_MAX_DEG, mapGridViewBbox } from './view.js';

	let { bundle = null, picked: pickedBefore = null, onselect }: { bundle?: NetworkBundle | null; picked?: string | null; onselect?: (code: string) => void } = $props();

	const uid = $props.id();
	const GRID_RETRY_MS = 60_000;
	let gridPausedUntil = 0;

	let quaternaries = $state.raw<QuaternaryCollection | null>(null);
	let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
	let loadError = $state.raw<MapRequestError | null>(null);
	// Kept across the landing page and a loaded network, which each have their own panel.
	let selected = $state<string | null>(untrack(() => pickedBefore));

	let showGrid = $state(false);
	let cells = $state.raw<MapGridCells | null>(null);
	let view = $state.raw<Box | null>(null);
	let gridStatus = $state('');
	let loadedBox: Box | null = null;
	// The box on its way: a second move before the answer mustn't ask for it again.
	let askedBox: Box | null = null;
	let gridRequest: AbortController | undefined;

	const features = $derived(quaternaries?.features ?? []);
	const picked = $derived(features.find((f) => f.properties.code === selected));
	const placement = $derived(bundle && quaternaries ? placeModules(bundle.modules, quaternaries.features) : null);
	const moduleCount = $derived(bundle?.modules.length ?? 0);
	const stride = $derived(cells ? mapGridStride(cells) : 1);
	/** What the MAP-grid tick is doing, in words: one always-present live region. */
	const gridNote = $derived(showGrid && view && !mapGridViewBbox(view) ? `Zoom in to see the MAP grid: it is asked for at most ${MAP_GRID_BBOX_MAX_DEG}° a side.` : gridStatus);

	async function load() {
		loadState = 'loading';
		loadError = null;
		try {
			quaternaries = await fetchQuaternaries({ baseUrl: API_BASE_URL });
			loadState = 'ready';
		} catch (error) {
			loadError = error instanceof MapRequestError ? error : new MapRequestError('server', 'The boundaries could not be loaded.');
			loadState = 'failed';
		}
	}

	onMount(() => {
		void load();
		return () => gridRequest?.abort();
	});

	function pick(code: string | null) {
		selected = code;
		if (code) onselect?.(code);
	}

	async function loadCells(box: Box) {
		gridRequest?.abort();
		const request = new AbortController();
		gridRequest = request;
		askedBox = box;
		gridStatus = 'Loading the MAP grid…';
		try {
			cells = await fetchMapGridCells(box, { baseUrl: API_BASE_URL, signal: request.signal });
			loadedBox = box;
			askedBox = null;
			gridStatus = '';
		} catch (error) {
			if (request.signal.aborted) return;
			askedBox = null;
			const refused = error instanceof MapRequestError ? error : new MapRequestError('server', 'The MAP grid could not be loaded.');
			if (refused.kind === 'no_coverage') {
				cells = null;
				loadedBox = box;
				gridStatus = 'No MAP grid covers this view. Sub-dividing here takes a typed MAP.';
			} else if (refused.kind === 'too_dense' || refused.kind === 'too_wide') {
				gridStatus = 'Zoom in to see the MAP grid here: this view holds more cells than one answer carries.';
			} else {
				gridStatus = refused.message;
				// Busy or failing: panning must not keep spending the shared request limit.
				gridPausedUntil = Date.now() + GRID_RETRY_MS;
			}
		}
	}

	// The tick and the view: a view inside the box already loaded asks for nothing.
	$effect(() => {
		if (!showGrid) {
			gridRequest?.abort();
			cells = null;
			loadedBox = null;
			askedBox = null;
			gridStatus = '';
			return;
		}
		if (!view) return;
		const box = mapGridViewBbox(view);
		if (box && !boxHolds(loadedBox, view) && !boxHolds(askedBox, view) && Date.now() >= gridPausedUntil) void loadCells(box);
	});

	const km2 = (v: number | undefined) => (v === undefined ? 'not given' : `${formatNumber(v, 1)} km²`);
	const mm = (v: number | undefined) => (v === undefined ? 'not given' : `${formatNumber(v, 0)} mm`);
</script>

<section class="card" aria-labelledby="map-h">
	<h2 id="map-h">Map</h2>
	{#if loadState === 'failed' && loadError}
		<div class="warn" role="status" data-testid="map-no-boundaries">
			{#if loadError.kind === 'unavailable'}
				<p><strong>Quaternary boundaries aren’t available here.</strong> You can carry on: run the network, and extend its rainfall from a boundary you upload (GeoJSON) under Extend rainfall. Picking a quaternary and splitting it needs the boundaries, which Pitman has no licence for yet.</p>
				<details>
					<summary>What the service said</summary>
					<p>{loadError.message}</p>
				</details>
			{:else}
				<p><strong>The quaternary boundaries didn’t load.</strong> {loadError.message}</p>
				<p>You can carry on with everything that doesn’t need them: run the network, and extend its rainfall from a boundary you upload.</p>
				<button type="button" onclick={load}>Try again</button>
			{/if}
		</div>
	{:else}
		<p class="lead">Which quaternary are you working in? Click it on the map or choose its code.</p>
	{/if}

	<div class="controls">
		{#if features.length > 0}
			<div class="field">
				<label for="{uid}-q">Quaternary</label>
				<select id="{uid}-q" value={selected ?? ''} onchange={(e) => pick(e.currentTarget.value || null)}>
					<option value="">Choose…</option>
					{#each features as f (f.properties.code)}<option value={f.properties.code}>{f.properties.code}</option>{/each}
				</select>
			</div>
		{:else if loadState === 'loading'}
			<p class="note" role="status">Loading the quaternaries…</p>
		{/if}
		<label class="tick"><input type="checkbox" bind:checked={showGrid} /> MAP grid</label>
		<p class="note grid-status" role="status" data-testid="map-grid-status">{gridNote}</p>
	</div>

	<Map {quaternaries} {selected} modules={placement?.placed ?? []} mapGrid={cells} onselect={pick} onview={(v) => (view = v)} />

	{#if showGrid}
		<div class="ramp" role="img" aria-label="MAP grid colours: light blue {MAP_RAMP_MM[0]} mm a year, up to dark blue {MAP_RAMP_MM.at(-1)} mm a year">
			{#each MAP_RAMP_MM as stop, i (stop)}
				<span class="stop"><span class="swatch r{i + 1}"></span>{stop}</span>
			{/each}
			<span class="unit">mm/yr</span>
		</div>
	{/if}

	{#if picked}
		<dl class="facts provenance" data-testid="map-selected-facts">
			<div><dt>Quaternary</dt><dd>{picked.properties.code}</dd></div>
			<div><dt>Area, from the boundary file</dt><dd>{km2(picked.properties.areaKm2)}</dd></div>
			<div><dt>MAP, from the boundary file</dt><dd>{mm(picked.properties.mapMm)}</dd></div>
		</dl>
	{/if}

	{#if bundle && quaternaries}
		<p class="note" data-testid="map-modules-placed">
			{placement?.placed.length ?? 0} of {moduleCount} {moduleCount === 1 ? 'module' : 'modules'} placed, by the quaternary code in the name.
			{#if placement?.unplaced.length}{placement.unplaced.length} couldn’t be placed: {placement.unplaced.length === 1 ? 'its name holds' : 'their names hold'} no code these boundaries know.{/if}
		</p>
		{#if placement?.unplaced.length}
			<details>
				<summary>Modules not on the map ({placement.unplaced.length})</summary>
				<ul class="unplaced">
					{#each placement.unplaced as m (m.id)}<li>{m.label}</li>{/each}
				</ul>
			</details>
		{/if}
	{/if}

	{#if quaternaries || cells}
		<h3>Where this comes from</h3>
		<dl class="sources">
			{#if quaternaries}
				<div data-testid="map-source-boundaries"><dt>Boundaries</dt><dd>{quaternaries.source}</dd></div>
			{/if}
			{#if cells}
				<div data-testid="map-source-grid">
					<dt>MAP grid</dt>
					<dd>
						{cells.dataset}, {cells.cellDeg}° cells: {cells.source}
						{#if stride > 1}Drawn every {stride} cells here to keep to {formatNumber(MAP_GRID_MAX_DRAWN, 0)} on screen; zoom in for every cell.{/if}
					</dd>
				</div>
			{/if}
		</dl>
	{/if}
</section>

<style>
	.lead {
		margin: 0 0 0.75rem;
	}
	.warn p {
		margin: 0 0 0.4rem;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
		margin-bottom: 0.6rem;
		min-height: var(--control-h);
	}
	.controls p {
		margin: 0;
	}
	.field,
	.tick {
		display: inline-flex;
		gap: 0.45rem;
		align-items: center;
	}
	.field label {
		font-weight: 600;
	}
	select {
		font-variant-numeric: tabular-nums;
	}
	.grid-status {
		flex: 1 1 14rem;
		font-size: var(--font-sm);
	}
	.ramp {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.75rem;
		align-items: center;
		margin-top: 0.4rem;
		font-size: var(--font-xs);
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}
	.stop {
		display: inline-flex;
		gap: 0.25rem;
		align-items: center;
	}
	.swatch {
		width: 0.9rem;
		height: 0.9rem;
		border: 1px solid var(--border-strong);
		border-radius: 2px;
	}
	.r1 {
		background: var(--map-ramp-1);
	}
	.r2 {
		background: var(--map-ramp-2);
	}
	.r3 {
		background: var(--map-ramp-3);
	}
	.r4 {
		background: var(--map-ramp-4);
	}
	.r5 {
		background: var(--map-ramp-5);
	}
	.unit {
		font-weight: 600;
	}
	h3 {
		margin: 1rem 0 0.25rem;
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.sources {
		margin: 0;
		font-size: var(--font-sm);
	}
	.sources div {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.5rem;
	}
	.sources dt {
		font-weight: 600;
	}
	.sources dd {
		margin: 0;
		flex: 1 1 16rem;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.unplaced {
		margin: 0.25rem 0 0;
		padding-left: 1.2rem;
		max-height: 12rem;
		overflow-y: auto;
		columns: 16rem;
		font-size: var(--font-sm);
	}
</style>
