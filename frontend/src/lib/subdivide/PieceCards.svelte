<!--
	Step 3's cards: one per piece, numbered as on the map. Each shows what will
	go into the network and where it came from: polygon and scaled area, the
	grid MAP with its cell size and source, a typed MAP in its place, where the
	piece's dams are and which module it becomes. The rows come from pieces.ts.
-->
<script lang="ts">
	import { formatNumber } from '#lib/results/format.js';
	import { MAX_MAP_MM, MIN_MAP_MM, gridSourceLine, parseMapMm, type PieceRow } from './pieces.js';

	let { rows, ontyped, onretry }: { rows: readonly PieceRow[]; ontyped: (id: string, text: string) => void; onretry: (id: string) => void } = $props();
</script>

<ol class="cards" aria-label="The pieces">
	{#each rows as row (row.id)}
		{@const titleId = `${row.id}-title`}
		{@const inputId = `${row.id}-map`}
		{@const msgId = `${row.id}-map-msg`}
		{@const typedCheck = row.typed.trim() === '' ? undefined : parseMapMm(row.typed)}
		<li class="piece" class:blocking={row.map.value === null && row.sample?.state !== 'loading'} data-piece={row.number} aria-labelledby={titleId}>
			<h4 id={titleId}><span class="badge" aria-hidden="true">{row.number}</span>{row.title}</h4>
			<dl>
				<div><dt>Polygon area</dt><dd data-value="polygon-km2">{formatNumber(row.polygonKm2, 1)} km²</dd></div>
				<div><dt>Area in the network</dt><dd data-value="area-km2">{row.areaKm2 === undefined ? 'not known yet' : `${formatNumber(row.areaKm2, 1)} km²`}</dd></div>
				<div>
					<dt>Grid MAP</dt>
					<dd data-value="grid-map">
						{#if row.sample?.state === 'ok'}
							{formatNumber(row.sample.sample.meanMapMm, 0)} mm
						{:else if row.sample?.state === 'loading'}
							Reading…
						{:else}
							none
						{/if}
					</dd>
				</div>
				<div>
					<dt>MAP used</dt>
					<dd data-value="map-used">{row.map.value === null ? 'none yet' : `${formatNumber(row.map.value, 0)} mm, ${row.map.source === 'typed' ? 'typed by you' : 'from the grid'}`}</dd>
				</div>
				{#if row.dams && row.dams.count > 0}
					<div><dt>Located farm dams</dt><dd data-value="dams">{row.dams.count}, {formatNumber(row.dams.capacityMm3, 3)} million m³</dd></div>
				{/if}
				{#if row.module}
					<div><dt>Module</dt><dd data-value="module">{row.module}</dd></div>
				{/if}
			</dl>
			{#if row.sample?.state === 'ok'}
				<p class="source">{gridSourceLine(row.sample.sample)}; values over {formatNumber(row.sample.sample.coveragePct, 0)} % of the piece.</p>
			{:else if row.sample?.state === 'failed'}
				<p class="warn">{row.sample.message}</p>
				{#if !row.sample.notCovered}
					<button type="button" onclick={() => onretry(row.id)}>Read the grid again<span class="sr"> for piece {row.number}</span></button>
				{/if}
			{/if}
			{#if row.resolution}
				<p class="note">{row.resolution}</p>
			{/if}
			<div class="input">
				<label for={inputId}>{row.sample?.state === 'ok' ? 'Type a MAP instead (optional)' : 'Type this piece’s MAP'}, whole mm</label>
				<input
					id={inputId}
					type="text"
					inputmode="numeric"
					autocomplete="off"
					spellcheck="false"
					value={row.typed}
					placeholder={`${MIN_MAP_MM} to ${MAX_MAP_MM.toLocaleString('en-ZA')}`}
					aria-invalid={typedCheck && !typedCheck.ok ? 'true' : undefined}
					aria-describedby={typedCheck && !typedCheck.ok ? msgId : undefined}
					oninput={(e) => ontyped(row.id, e.currentTarget.value)}
				/>
			</div>
			{#if typedCheck && !typedCheck.ok}
				<p id={msgId} class="error">{typedCheck.error}</p>
			{/if}
		</li>
	{/each}
</ol>

<style>
	.cards {
		list-style: none;
		margin: 0.75rem 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
		gap: 0.75rem;
	}
	.piece {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 0.6rem 0.75rem 0.75rem;
		background: var(--surface);
		min-width: 0;
	}
	.piece.blocking {
		border-color: var(--danger);
		border-width: 2px;
	}
	h4 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 1.6rem;
		height: 1.6rem;
		border-radius: 50%;
		background: var(--accent);
		color: var(--on-accent);
		font-size: var(--font-sm);
		font-weight: 700;
	}
	dl {
		margin: 0;
		font-size: 0.875rem;
		font-variant-numeric: tabular-nums;
	}
	dl div {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.1rem 0;
	}
	dt {
		color: var(--text-muted);
		flex: none;
	}
	dd {
		margin: 0;
		text-align: right;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.source {
		font-size: var(--font-sm);
		color: var(--text-muted);
		border-left: 3px solid var(--accent);
		padding-left: 0.5rem;
		margin: 0.5rem 0;
		overflow-wrap: anywhere;
	}
	.note {
		font-size: var(--font-sm);
		margin: 0.35rem 0;
	}
	.input {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-top: 0.5rem;
	}
	.input label {
		font-size: 0.875rem;
	}
	.input input {
		width: 100%;
	}
	.error {
		font-size: 0.875rem;
		margin: 0.35rem 0 0;
	}
</style>
