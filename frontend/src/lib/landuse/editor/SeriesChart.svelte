<!--
	One table's series over time with its accessible alternative: a key, the
	uPlot canvas (described as an image) and a collapsible table of every year,
	as #lib/extend/FitChart.svelte does. Edited years are hollow diamonds on a
	dashed line, so they show without colour; the table says it in words.
-->
<script lang="ts">
	import { seriesDataTable, X_LABEL, type SeriesChartSpec } from './chart.js';
	import { EDITED_STYLE, FILE_STYLE, seriesPlot } from './plot.js';
	import type { RowView } from './review.js';

	let { spec, rows }: { spec: SeriesChartSpec; rows: readonly RowView[] } = $props();

	let open = $state(false);
	const table = $derived(open ? seriesDataTable(spec, rows) : null);
	const editedYears = $derived(spec.x.filter((_, i) => spec.editedMarks[i] !== null));
</script>

<figure class="chart" data-chart={spec.id}>
	<figcaption>
		<h4 id={`${spec.id}-title`}>{spec.title} over time</h4>
		<span class="axes">{spec.yLabel}; {X_LABEL.toLowerCase()}.</span>
	</figcaption>
	<ul class="key" aria-label="Key">
		<li>
			<svg width="32" height="10" aria-hidden="true">
				<line x1="0" y1="5" x2="32" y2="5" stroke={FILE_STYLE.stroke} stroke-width="2" />
				<circle cx="16" cy="5" r="3" fill={FILE_STYLE.stroke} />
			</svg>
			In the network file
		</li>
		{#if spec.edited}
			<li>
				<svg width="32" height="12" aria-hidden="true">
					<line x1="0" y1="6" x2="32" y2="6" stroke={EDITED_STYLE.stroke} stroke-width="2" stroke-dasharray={EDITED_STYLE.dash.join(' ')} />
					<path d="M16 1 L21 6 L16 11 L11 6 Z" fill="var(--surface)" stroke={EDITED_STYLE.stroke} stroke-width="2" />
				</svg>
				With your edits
			</li>
		{/if}
	</ul>
	<div
		class="canvas"
		role="img"
		aria-label="{spec.title} against {X_LABEL.toLowerCase()}: straight between listed years and flat beyond them.{editedYears.length > 0 ? ` Edited: ${editedYears.join(', ')}.` : ''} Every year is in the data table below."
		use:seriesPlot={spec}
	></div>
	<details bind:open>
		<summary>Data table: {spec.title.toLowerCase()} every year</summary>
		{#if table}
			<div class="scroll">
				<table class="data">
					<caption>{table.caption}</caption>
					<thead>
						<tr>
							{#each table.columns as column (column)}
								<th scope="col">{column}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each table.rows as row (row[0])}
							<tr>
								<th scope="row">{row[0]}</th>
								{#each row.slice(1) as cell, j (j)}
									<td>{cell}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</details>
</figure>

<style>
	.chart {
		margin: 0;
		min-width: 0;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 0.75rem 1rem;
	}
	h4 {
		margin: 0 0 0.25rem;
		font-size: 0.95rem;
	}
	.axes {
		display: block;
		font-size: var(--font-sm);
		color: var(--text-muted);
		margin-bottom: 0.25rem;
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		list-style: none;
		margin: 0 0 0.25rem;
		padding: 0;
		font-size: 0.875rem;
	}
	.key li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.canvas {
		min-height: 240px;
	}
	.scroll {
		max-height: 20rem;
		overflow: auto;
	}
	table {
		font-size: var(--font-sm);
	}
	th,
	td {
		padding: 0.15rem 0.5rem;
	}
	thead th {
		position: sticky;
		top: 0;
	}
</style>
