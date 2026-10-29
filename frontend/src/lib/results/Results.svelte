<!--
	Results for a loaded network: one entry in `runs` per mode the user ran.
	The props are the contract with the app shell (agent 3.4): keep their
	names and types. Logic lives in the .ts modules beside this file
	(targets, analysis, charts, statistics-table, downloads); this component
	only wires them to the page. Spec: docs/theory/statistics.md.
-->
<script lang="ts">
	import type { NetworkBundle, RunResult } from '@pitman/wrsm';
	import ChartFigure from './ChartFigure.svelte';
	import { analyseTarget } from './analysis.js';
	import { targetCharts } from './charts.js';
	import { answerDownload, csvDownload, type Download } from './downloads.js';
	import { hydroYearLabel } from './format.js';
	import { statisticsTable } from './statistics-table.js';
	import { defaultTarget, resultTargets, targetSeries } from './targets.js';

	let { bundle, runs }: { bundle: NetworkBundle; runs: readonly RunResult[] } = $props();

	const groups = $derived(resultTargets(bundle, runs));
	const allTargets = $derived(groups.flatMap((g) => g.targets));
	let chosenId = $state<string | null>(null);
	const target = $derived(allTargets.find((t) => t.id === chosenId) ?? defaultTarget(groups));

	// The statistics period and the incomplete-months switch, kept per target.
	let period = $state<{ id: string; startYear?: number; endYear?: number }>({ id: '' });
	let includeIncomplete = $state(true);
	const analysis = $derived(
		target === null
			? null
			: analyseTarget(target, runs, {
					...(period.id === target.id ? { startYear: period.startYear, endYear: period.endYear } : {}),
					includeIncomplete
				})
	);
	const charts = $derived(analysis === null ? [] : targetCharts(analysis));
	const stats = $derived(analysis === null ? null : statisticsTable(analysis));
	const record = $derived(analysis?.timeline ?? null);

	let downloadError = $state('');

	function setYear(which: 'startYear' | 'endYear', value: string) {
		if (target === null) return;
		const year = Number(value);
		const current = period.id === target.id ? period : { id: target.id };
		period = { ...current, id: target.id, [which]: value === '' || !Number.isInteger(year) ? undefined : year };
	}

	function resetPeriod() {
		period = { id: '' };
	}

	function save(make: () => Download | null) {
		downloadError = '';
		let file: Download | null;
		try {
			file = make();
		} catch (e) {
			downloadError = `Could not write the file: ${e instanceof Error ? e.message : String(e)}`;
			return;
		}
		if (file === null) return;
		const url = URL.createObjectURL(new Blob([file.text], { type: file.mimeType }));
		const a = document.createElement('a');
		a.href = url;
		a.download = file.fileName;
		document.body.append(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
</script>

<section class="results" aria-labelledby="results-title">
	<h2 id="results-title">Results</h2>

	{#if runs.length === 0}
		<p>Run the network to see results.</p>
	{:else if target === null || analysis === null}
		<p>The run produced no route flows or reservoir storage to show.</p>
	{:else}
		<p class="runs">
			Network {bundle.network.code}, {runs.length === 1 ? 'one run' : `${runs.length} runs side by side`}:
			{analysis.runs.map((r) => r.label).join(', ')}.
			Flows in million m³ per month; hydrological years run October to September.
		</p>

		<div class="picker">
			<label for="results-target">Route or reservoir</label>
			<select id="results-target" value={target.id} onchange={(e) => (chosenId = e.currentTarget.value)}>
				{#each groups as group (group.label)}
					<optgroup label={group.label}>
						{#each group.targets as t (t.id)}
							<option value={t.id}>{t.label}</option>
						{/each}
					</optgroup>
				{/each}
			</select>
			{#if target.gauge !== null && target.observed === null}
				<p class="note">The gauge's observed-flow file ({target.gauge.observedFile.trim()}) is not in the network folder.</p>
			{/if}
		</div>

		<h3 class="target-title">{target.label}</h3>

		{#if record !== null}
			<fieldset class="period">
				<legend>Statistics period (hydrological years)</legend>
				<label>
					From
					<input
						type="number"
						inputmode="numeric"
						min={record.startYear}
						max={record.startYear + record.years - 1}
						value={analysis.period?.startYear ?? ''}
						onchange={(e) => setYear('startYear', e.currentTarget.value)}
					/>
				</label>
				<label>
					to
					<input
						type="number"
						inputmode="numeric"
						min={record.startYear}
						max={record.startYear + record.years - 1}
						value={analysis.period?.endYear ?? ''}
						onchange={(e) => setYear('endYear', e.currentTarget.value)}
					/>
				</label>
				<button type="button" onclick={resetPeriod}>{target.observed !== null ? 'Gauge record' : 'Whole record'}</button>
				{#if target.observed !== null}
					<label class="check">
						<input type="checkbox" bind:checked={includeIncomplete} />
						Use incomplete observed months (+)
					</label>
				{/if}
				{#if analysis.period}
					<p class="note">{hydroYearLabel(analysis.period.startYear)} to {hydroYearLabel(analysis.period.endYear)}; mean monthly flows, the duration curve and the statistics cover this period.</p>
				{/if}
			</fieldset>
		{/if}

		{#if stats}
			<div class="stats">
				<div class="scroll">
					<table>
						<caption>{stats.caption}</caption>
						<thead>
							<tr>
								{#each stats.columns as column (column)}
									<th scope="col">{column}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each stats.rows as row (row.key)}
								<tr data-statistic={row.key}>
									<th scope="row">{row.label}</th>
									<td class="unit">{row.unit}</td>
									{#each row.cells as cell, j (j)}
										<td class:outside={cell.verdict === 'outside'}>{cell.text}</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#each stats.notes as note (note)}
					<p class="note">{note}</p>
				{/each}
			</div>
		{/if}

		<div class="charts">
			{#each charts as spec (spec.id)}
				<ChartFigure {spec} idPrefix="results-{target.id}" />
			{/each}
		</div>

		<div class="downloads" role="group" aria-labelledby="results-downloads">
			<h4 id="results-downloads">Downloads</h4>
			<ul>
				{#each runs as run, i (i)}
					{@const series = targetSeries(run, target)}
					{#if series !== null}
						<li>
							<button type="button" onclick={() => save(() => answerDownload(bundle.network.code, target, series, run.mode, runs.length > 1))}>
								Download .ANS ({analysis.runs[i]?.label})
							</button>
						</li>
					{/if}
				{/each}
				<li>
					<button type="button" onclick={() => save(() => csvDownload(bundle.network.code, analysis))}>Download CSV (all runs{target.observed !== null ? ' and observed' : ''})</button>
				</li>
			</ul>
			<p class="note">.ANS files use WRSM2000's answer-file layout (million m³, one row per hydrological year), so WRSM2000 and Pitman can read them back.</p>
			{#if downloadError}
				<p role="alert" class="error">{downloadError}</p>
			{/if}
		</div>
	{/if}
</section>

<style>
	.results {
		max-width: 72rem;
		min-width: 0;
	}
	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 1rem;
	}
	select {
		max-width: 100%;
		font: inherit;
		padding: 0.35rem;
	}
	.target-title {
		font-size: 1.15rem;
		margin: 0.5rem 0;
	}
	.period {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		border: 1px solid #ccc;
		margin: 0 0 1rem;
	}
	.period input[type='number'] {
		width: 6.5rem;
		font: inherit;
	}
	.period .note {
		flex-basis: 100%;
		margin: 0;
	}
	.check {
		display: inline-flex;
		gap: 0.35rem;
		align-items: center;
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		font-variant-numeric: tabular-nums;
		font-size: 0.875rem;
	}
	caption {
		text-align: left;
		font-weight: 600;
		padding-bottom: 0.25rem;
	}
	th,
	td {
		padding: 0.25rem 0.5rem;
		border-bottom: 1px solid #ddd;
		text-align: right;
		white-space: nowrap;
	}
	tbody th,
	.unit {
		text-align: left;
	}
	tbody th {
		font-weight: normal;
	}
	.unit {
		color: #555;
	}
	/* The word "outside" carries the meaning; weight and colour only repeat it. */
	td.outside {
		font-weight: 600;
		color: #a01d00;
	}
	.note {
		font-size: 0.85rem;
		color: #444;
	}
	.charts {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.5rem;
		margin-top: 1rem;
	}
	@media (min-width: 64rem) {
		.charts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.downloads ul {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		list-style: none;
		padding: 0;
	}
	button {
		font: inherit;
		padding: 0.35rem 0.75rem;
		min-height: 2.75rem;
	}
	.error {
		color: #a01d00;
	}
</style>
