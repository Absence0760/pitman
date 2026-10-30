<!--
	One chart with its accessible alternative: a heading, the uPlot canvas
	(described as an image, since a canvas has no text) and a collapsible data
	table with every plotted value. The table is only built when opened.
-->
<script lang="ts">
	import { scrollable } from '#lib/shell/scrollable.js';
	import { chartTable, type ChartSpec } from './charts.js';
	import { plot, styleOf } from './plot.js';

	let { spec, idPrefix }: { spec: ChartSpec; idPrefix: string } = $props();

	let open = $state(false);
	const table = $derived(open ? chartTable(spec) : null);
	const headingId = $derived(`${idPrefix}-${spec.id}-title`);
</script>

<figure class="chart" data-chart={spec.id}>
	<figcaption>
		<h4 id={headingId}>{spec.title}</h4>
		<span class="axes">{spec.yLabel}; {spec.xLabel}.</span>
	</figcaption>
	<ul class="key" aria-label="Key">
		{#each spec.lines as line (line.label)}
			{@const style = styleOf(line)}
			<li>
				<svg width="32" height="10" aria-hidden="true">
					{#if spec.bars}
						<rect x="8" y="0" width="16" height="10" fill={style.stroke} fill-opacity="0.53" stroke={style.stroke} />
					{:else}
						<line x1="0" y1="5" x2="32" y2="5" stroke={style.stroke} stroke-width={line.style === 'observed' ? 2.5 : 2} stroke-dasharray={style.dash.join(' ')} />
					{/if}
				</svg>
				{line.label}
			</li>
		{/each}
	</ul>
	<div
		class="canvas"
		role="img"
		aria-label="{spec.title}: {spec.yLabel} against {spec.xLabel}. Every value is in the data table below."
		use:plot={spec}
	></div>
	<details bind:open>
		<summary>Data table: {spec.title}</summary>
		{#if table}
			<div class="scroll" use:scrollable>
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
		min-height: 280px;
	}
	.axes {
		display: block;
		font-size: var(--font-sm);
		color: var(--text-muted);
		margin-bottom: 0.25rem;
	}
	.scroll {
		max-height: 24rem;
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
