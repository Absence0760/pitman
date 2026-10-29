<!--
	One fit-diagnostics chart with its accessible alternative, as
	#lib/results/ChartFigure.svelte does for the results: a heading, a key,
	the uPlot canvas (described as an image) and a collapsible data table.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { chartTable, type ExtendChartSpec, type ScatterPoint } from './charts.js';
	import { extendPlot, seriesStyle } from './plot.js';

	let { spec, points, controls }: { spec: ExtendChartSpec; points?: readonly ScatterPoint[]; controls?: Snippet } = $props();

	let open = $state(false);
	const table = $derived(open ? chartTable(spec, points) : null);
</script>

<figure class="chart" data-chart={`extend-${spec.id}`}>
	<figcaption>
		<h4 id={`extend-${spec.id}-title`}>{spec.title}</h4>
		<span class="axes">{spec.yLabel}; {spec.xLabel}.</span>
	</figcaption>
	{#if controls}
		<div class="controls">{@render controls()}</div>
	{/if}
	<ul class="key" aria-label="Key">
		{#each spec.series as s (s.label)}
			{@const style = seriesStyle(s)}
			<li>
				<svg width="32" height="10" aria-hidden="true">
					{#if s.mark === 'points'}
						<circle cx="16" cy="5" r="4" fill={style.stroke} />
					{:else if s.mark === 'bars'}
						<rect x="8" y="0" width="16" height="10" fill={`${style.stroke}66`} stroke={style.stroke} />
					{:else}
						<line x1="0" y1="5" x2="32" y2="5" stroke={style.stroke} stroke-width="2" stroke-dasharray={style.dash.join(' ')} />
					{/if}
				</svg>
				{s.label}
			</li>
		{/each}
		{#each spec.bands as band (band.label)}
			<li>
				<svg width="32" height="10" aria-hidden="true"><rect x="0" y="0" width="32" height="10" fill="rgba(128,128,128,0.3)" /></svg>
				{band.label}
			</li>
		{/each}
	</ul>
	<div
		class="canvas"
		role="img"
		aria-label="{spec.title}: {spec.yLabel} against {spec.xLabel}. Every value is in the data table below."
		use:extendPlot={spec}
	></div>
	<details bind:open>
		<summary>Data table: {spec.title}</summary>
		{#if table}
			<div class="scroll">
				<table>
					<caption>{table.caption}</caption>
					<thead>
						<tr>
							{#each table.columns as column, i (i)}
								<th scope="col">{column}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each table.rows as row, i (i)}
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
		margin: 0 0 1.5rem;
		min-width: 0;
	}
	h4 {
		margin: 0 0 0.25rem;
		font-size: 1.05rem;
	}
	.axes {
		display: block;
		font-size: 0.8rem;
		color: var(--text-muted);
		margin-bottom: 0.25rem;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
		margin: 0.25rem 0 0.5rem;
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
		width: 100%;
		min-height: 300px;
		overflow: hidden;
		color: var(--text);
	}
	.scroll {
		max-height: 24rem;
		overflow: auto;
	}
	table {
		border-collapse: collapse;
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
	}
	th,
	td {
		padding: 0.15rem 0.5rem;
		text-align: right;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	thead th {
		position: sticky;
		top: 0;
		background: var(--surface);
	}
	tbody th {
		text-align: left;
		font-weight: normal;
	}
	caption {
		text-align: left;
		font-weight: 600;
		padding: 0.25rem 0;
	}
	summary {
		cursor: pointer;
		font-size: 0.875rem;
		min-height: 2rem;
	}
	.canvas :global(.u-legend) {
		font-size: 0.75rem;
	}
</style>
