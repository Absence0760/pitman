<!--
	Before and after the split at the outlet: the mean annual flow per run mode
	and the mean monthly flows, October first. Route numbers survive a split,
	so one route reads both sets of results (outlet.ts); the user can pick
	another. Only modes in both sets compare, over the years both ran.
-->
<script lang="ts">
	import { scrollable } from '#lib/shell/scrollable.js';
	import type { NetworkBundle, RunResult } from '@pitman/wrsm';
	import ChartFigure from '#lib/results/ChartFigure.svelte';
	import { ANNUAL_FLOW_UNIT, formatNumber } from '#lib/results/format.js';
	import { formatPercent } from './calibration.js';
	import { outletChart, outletPairs, outletRows, routeChoices } from './outlet.js';

	let { bundle, before, after, initialRoute }: { bundle: NetworkBundle; before: readonly RunResult[]; after: readonly RunResult[]; initialRoute: number | undefined } = $props();

	// svelte-ignore state_referenced_locally
	let route = $state(initialRoute);
	const choices = $derived(routeChoices(bundle));
	const pairs = $derived(outletPairs(before, after));
	const rows = $derived(route === undefined ? [] : outletRows(pairs, route));
	let mode = $state<string | undefined>();
	const pair = $derived(pairs.find((p) => p.slug === mode) ?? pairs[0]);
	const chart = $derived(pair && route !== undefined ? outletChart(pair, route) : undefined);
</script>

<h3 id="subdivide-outlet-h">Before and after at the outlet</h3>
{#if pairs.length === 0}
	<p class="note">The rerun used different modes from the run before the split, so there is nothing to compare. Run the same modes to see the difference.</p>
{:else}
	<div class="field">
		<label for="subdivide-outlet">Compare at</label>
		<select id="subdivide-outlet" bind:value={route}>
			{#each choices as c (c.route)}<option value={c.route}>{c.label}</option>{/each}
		</select>
	</div>
	<p class="note">Pitman starts at the first route all of the module’s water reaches. Choose another to look elsewhere.</p>
	<div class="scroll" use:scrollable>
		<table class="data" data-table="outlet">
			<caption>Mean annual flow at route {route}, {ANNUAL_FLOW_UNIT}</caption>
			<thead>
				<tr>
					<th scope="col">Mode</th>
					<th scope="col">Before</th>
					<th scope="col">After</th>
					<th scope="col">Change</th>
					<th scope="col">Change, %</th>
					<th scope="col">Years</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.slug)}
					<tr data-mode={row.slug}>
						<th scope="row">{row.label}</th>
						<td>{formatNumber(row.before, 3)}</td>
						<td>{formatNumber(row.after, 3)}</td>
						<td>{formatNumber(row.change, 3)}</td>
						<td>{row.changePct === null ? '—' : formatPercent(row.changePct)}</td>
						<td>{row.period}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if pairs.length > 1}
		<div class="field">
			<label for="subdivide-outlet-mode">Mode in the chart</label>
			<select id="subdivide-outlet-mode" value={pair?.slug} onchange={(e) => (mode = e.currentTarget.value)}>
				{#each rows as row (row.slug)}<option value={row.slug}>{row.label}</option>{/each}
			</select>
		</div>
	{/if}
	{#if chart}
		{#key chart}
			<ChartFigure spec={chart} idPrefix="subdivide-outlet" />
		{/key}
	{/if}
{/if}

<style>
	h3 {
		margin: 1rem 0 0.25rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
		margin: 0.5rem 0;
	}
	.field select {
		width: 100%;
		max-width: 36rem;
	}
	.scroll {
		margin: 0.75rem 0;
	}
</style>
