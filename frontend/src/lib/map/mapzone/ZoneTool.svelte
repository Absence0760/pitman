<!--
	The MAP-zone split (subdivide.md § MAP-zone split): a zone from the MAP
	grid with a movable threshold, drawn on the map, or pasted. Whichever way,
	the proposal shows on the map and in numbers here before it is accepted;
	a piece under 1 km² is refused in the engine's words. The tool only
	reports: the panel owns the pieces and the map.
-->
<script lang="ts">
	import type { AreaGeometry, MapGridCells, SplitRecord } from '@pitman/wrsm';
	import type { MapTool } from '#lib/map/contract.js';
	import { formatNumber } from '#lib/results/format.js';
	import type { SubdivideData } from '#lib/subdivide/data.js';
	import type { SubdivideEngine } from '#lib/subdivide/engine.js';
	import { bboxOf } from '#lib/subdivide/geometry.js';
	import { formatCellDeg } from '#lib/subdivide/pieces.js';
	import { parseZone } from './paste.js';
	import { THRESHOLD_STEP_MM, noZoneMessage, sideSummary, thresholdProblem, thresholdRange, valuesInside, type ZoneSide } from './threshold.js';

	type Zone = ReturnType<SubdivideEngine['splitByZone']>;
	type Way = 'threshold' | 'draw' | 'paste';

	let {
		within,
		label,
		engine,
		data,
		drawn,
		canDraw,
		ontool,
		ongrid,
		onproposal,
		onaccept
	}: {
		/** The piece being split. */
		within: AreaGeometry;
		/** Its name, for the sentences here. */
		label: string;
		engine: SubdivideEngine;
		data: SubdivideData;
		/** The polygon last finished on the map. */
		drawn: AreaGeometry | null;
		/** A map is on the page. */
		canDraw: boolean;
		ontool: (tool: MapTool) => void;
		/** The grid to draw while the threshold tool is on. */
		ongrid: (cells: MapGridCells | null) => void;
		onproposal: (zone: AreaGeometry | null) => void;
		onaccept: (zone: Zone, record: SplitRecord) => void;
	} = $props();

	let way = $state<Way>('threshold');
	let side = $state<ZoneSide>('high');
	let t = $state<number | null>(null);
	let cells = $state.raw<MapGridCells | undefined>();
	let sorted = $state.raw<readonly number[]>([]);
	let cellsError = $state<string | undefined>();
	let loading = $state(false);
	let pasted = $state('');
	let pasteError = $state<string | undefined>();

	let proposal = $state.raw<{ zone: Zone; record: SplitRecord } | undefined>();
	let refusal = $state<string | undefined>();

	const range = $derived(thresholdRange(sorted));
	const summary = $derived(t !== null ? sideSummary(sorted, t, side) : undefined);
	const typedProblem = $derived(range ? thresholdProblem(t, range) : null);
	/** The controls have moved on from the zone shown: it can't be accepted as what they say until it catches up. */
	const pending = $derived(proposal?.record.kind === 'zone-threshold' && (proposal.record.thresholdMm !== t || proposal.record.side !== side));

	function show(next: { zone: Zone; record: SplitRecord } | undefined, why?: string) {
		proposal = next;
		refusal = why;
		onproposal(next?.zone.zone ?? null);
	}

	function propose(zone: AreaGeometry, record: SplitRecord) {
		try {
			show({ zone: engine.splitByZone(within, zone), record });
		} catch (error) {
			show(undefined, (error as Error).message);
		}
	}

	async function loadCells(signal: AbortSignal) {
		loading = true;
		cellsError = undefined;
		try {
			const answer = await data.mapGridCells(bboxOf(within), signal);
			if (signal.aborted) return;
			cells = answer;
			sorted = valuesInside(answer, within);
			const next = thresholdRange(sorted);
			t = next?.startMm ?? null;
		} catch (error) {
			if ((error as Error).name !== 'AbortError') cellsError = (error as Error).message;
		} finally {
			if (!signal.aborted) loading = false;
		}
	}

	// The way decides what the map does; leaving it clears what it showed.
	$effect(() => {
		ontool(way === 'draw' ? 'draw' : 'select');
		ongrid(way === 'threshold' ? (cells ?? null) : null);
	});

	$effect(() => {
		if (way !== 'threshold' || cells || cellsError !== undefined) return;
		const controller = new AbortController();
		void loadCells(controller.signal);
		return () => controller.abort();
	});

	// The engine traces the zone; waiting for a pause keeps the slider smooth on a million-cell grid.
	$effect(() => {
		if (way !== 'threshold' || !cells || !range) return;
		const grid = cells;
		const mm = t;
		const chosen = side;
		if (mm === null || thresholdProblem(mm, range) !== null) {
			show(undefined);
			return;
		}
		const timer = setTimeout(() => {
			try {
				const zone = engine.zoneFromThreshold(grid, within, mm, chosen);
				if (zone === null) show(undefined, noZoneMessage(mm, chosen));
				else propose(zone, { kind: 'zone-threshold', thresholdMm: mm, side: chosen });
			} catch (error) {
				show(undefined, (error as Error).message);
			}
		}, 150);
		return () => clearTimeout(timer);
	});

	$effect(() => {
		if (way === 'draw' && drawn) propose(drawn, { kind: 'zone-drawn' });
	});

	function changeWay(next: Way) {
		way = next;
		pasteError = undefined;
		show(undefined);
	}

	function usePasted() {
		const parsed = parseZone(pasted);
		if (parsed.ok) {
			pasteError = undefined;
			propose(parsed.geometry, { kind: 'zone-drawn' });
		} else {
			pasteError = parsed.error;
			show(undefined);
			document.getElementById('zone-paste')?.focus();
		}
	}

	function accept() {
		if (proposal && !pending) onaccept(proposal.zone, proposal.record);
	}
</script>

<fieldset class="ways">
	<legend>Find the zone</legend>
	<div class="radio">
		<input type="radio" id="zone-way-threshold" name="zone-way" checked={way === 'threshold'} onchange={() => changeWay('threshold')} />
		<label for="zone-way-threshold">From the MAP grid: everything above or below a rainfall you choose</label>
	</div>
	<div class="radio">
		<input type="radio" id="zone-way-draw" name="zone-way" checked={way === 'draw'} disabled={!canDraw} onchange={() => changeWay('draw')} />
		<label for="zone-way-draw">Draw it on the map{canDraw ? '' : ' (no map on this page)'}</label>
	</div>
	<div class="radio">
		<input type="radio" id="zone-way-paste" name="zone-way" checked={way === 'paste'} onchange={() => changeWay('paste')} />
		<label for="zone-way-paste">Paste a polygon (GeoJSON or WKT)</label>
	</div>
</fieldset>

{#if way === 'threshold'}
	{#if loading}
		<p class="note" role="status">Reading the MAP grid over {label}…</p>
	{:else if cellsError}
		<p class="error" role="alert">The MAP grid could not be read: {cellsError}</p>
		<div class="actions">
			<button type="button" onclick={() => (cellsError = undefined)}>Try again</button>
		</div>
	{:else if cells && !range}
		<p class="note">
			The grid {sorted.length === 0 ? 'has no value' : `has one value, ${formatNumber(sorted[0], 0)} mm,`} inside {label}, so there is nothing to separate. Draw or paste the zone instead.
		</p>
	{:else if cells && range}
		<dl class="facts provenance" aria-label="Where the threshold’s numbers come from" data-provenance="zone-grid">
			<div><dt>MAP grid</dt><dd>{cells.dataset}, {formatCellDeg(cells.cellDeg)} cells</dd></div>
			<div><dt>Source</dt><dd>{cells.source}</dd></div>
			<div><dt>Over {label}</dt><dd>{sorted.length.toLocaleString('en-ZA')} cells, {formatNumber(sorted[0], 0)} to {formatNumber(sorted[sorted.length - 1], 0)} mm</dd></div>
		</dl>
		<fieldset class="ways">
			<legend>Which side is the zone</legend>
			<div class="radio">
				<input type="radio" id="zone-side-high" name="zone-side" bind:group={side} value="high" />
				<label for="zone-side-high">High: MAP at or above the threshold</label>
			</div>
			<div class="radio">
				<input type="radio" id="zone-side-low" name="zone-side" bind:group={side} value="low" />
				<label for="zone-side-low">Low: MAP at or below the threshold</label>
			</div>
		</fieldset>
		<div class="threshold">
			<label for="zone-threshold-range">Threshold, mm of MAP</label>
			<div class="row">
				<input
					id="zone-threshold-range"
					type="range"
					min={range.minMm}
					max={range.maxMm}
					step={THRESHOLD_STEP_MM}
					value={t ?? range.minMm}
					aria-valuetext={`${t ?? range.minMm} mm`}
					oninput={(e) => (t = Number(e.currentTarget.value))}
				/>
				<label class="sr" for="zone-threshold-mm">Threshold, typed, in mm</label>
				<input id="zone-threshold-mm" type="number" min={range.minMm} max={range.maxMm} step={THRESHOLD_STEP_MM} bind:value={t} aria-invalid={typedProblem ? 'true' : undefined} aria-describedby={typedProblem ? 'zone-threshold-error' : undefined} />
				<span class="unit">mm</span>
			</div>
			{#if typedProblem}
				<p id="zone-threshold-error" class="error">{typedProblem}</p>
			{:else if summary}
				<p class="note">
					{summary.cells.toLocaleString('en-ZA')} of {sorted.length.toLocaleString('en-ZA')} cells ({formatNumber(summary.sharePct, 0)} %) are in the zone.
					Plain mean of the cells: zone {formatNumber(summary.zoneMeanMm, 0)} mm, the rest {formatNumber(summary.restMeanMm, 0)} mm. Step 3 gives each piece’s area-weighted MAP.
				</p>
			{/if}
		</div>
	{/if}
{:else if way === 'draw'}
	<p class="note">Click round the zone on the map and close it on the first point. It is clipped to {label}.</p>
{:else}
	<div class="paste">
		<label for="zone-paste">Polygon, in longitude/latitude; it is clipped to {label}</label>
		<textarea
			id="zone-paste"
			rows="5"
			spellcheck="false"
			autocomplete="off"
			placeholder="POLYGON ((20.1 -33.5, 20.2 -33.5, 20.2 -33.4, 20.1 -33.5))"
			bind:value={pasted}
			aria-invalid={pasteError ? 'true' : undefined}
			aria-describedby={pasteError ? 'zone-paste-error' : undefined}
		></textarea>
		{#if pasteError}
			<p id="zone-paste-error" class="error" role="alert">{pasteError}</p>
		{/if}
		<div class="actions">
			<button type="button" onclick={usePasted}>Use this polygon</button>
		</div>
	</div>
{/if}

<div aria-live="polite" data-zone-proposal={proposal ? 'ready' : refusal ? 'refused' : 'none'}>
	{#if proposal}
		<dl class="facts" aria-label="The proposed split">
			<div><dt>Proposed zone</dt><dd data-value="zone-km2">{formatNumber(proposal.zone.zoneKm2, 1)} km²</dd></div>
			<div><dt>The rest of {label}</dt><dd data-value="rest-km2">{formatNumber(proposal.zone.restKm2, 1)} km²</dd></div>
		</dl>
		<div class="actions">
			<button type="button" class="primary" onclick={accept} disabled={pending}>Accept this zone</button>
			{#if pending}
				<p class="note">Tracing the zone at the new threshold…</p>
			{/if}
		</div>
	{:else if refusal}
		<p class="warn"><strong>Not possible:</strong> {refusal}</p>
	{/if}
</div>

<style>
	.ways {
		margin: 0.75rem 0;
	}
	.radio {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		min-height: var(--control-h);
	}
	.threshold,
	.paste {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0.75rem 0;
	}
	.row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	input[type='range'] {
		flex: 1;
		min-width: 0;
		min-height: var(--control-h);
		accent-color: var(--accent);
		margin: 0;
	}
	input[type='number'] {
		width: 6rem;
		flex: none;
	}
	.unit {
		color: var(--text-muted);
		font-size: var(--font-sm);
	}
	textarea {
		font-family: var(--font-mono);
		font-size: var(--font-sm);
		width: 100%;
		padding: 0.5rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		resize: vertical;
	}
	textarea[aria-invalid='true'] {
		border: 2px solid var(--danger);
	}
	.note,
	.error {
		margin: 0.35rem 0;
	}
</style>
