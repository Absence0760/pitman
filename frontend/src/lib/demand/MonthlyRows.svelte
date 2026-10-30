<!--
	A demand file's rows, October first, one row per hydrological year. A long
	record stays in a box of its own, with the year and the header in view. With
	`checks` it also shows what was asked for each year against what the file holds.
-->
<script lang="ts">
	import type { DemandYearCheck, MonthlyRow } from '@pitman/wrsm';
	import { HYDRO_MONTHS, formatNumber, hydroYearLabel } from '#lib/results/format.js';

	let { rows, caption, checks }: { rows: readonly MonthlyRow[]; caption: string; checks?: readonly DemandYearCheck[] } = $props();

	const total = (row: MonthlyRow) => row.months.reduce((a, b) => a + b, 0);
	const checkOf = $derived(new Map((checks ?? []).map((c) => [c.year, c])));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (a box that scrolls must be reachable by keyboard) -->
<div class="rows" tabindex="0" role="region" aria-label={caption}>
	<table class="data">
		<caption>{caption}</caption>
		<thead>
			<tr>
				<th scope="col">Year</th>
				<th scope="col">Total</th>
				{#if checks}
					<th scope="col">Asked</th>
				{/if}
				{#each HYDRO_MONTHS as month (month)}
					<th scope="col">{month}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each rows as row (row.year)}
				<tr>
					<th scope="row">{hydroYearLabel(row.year)}</th>
					<td class="total">{formatNumber(total(row), 2)}</td>
					{#if checks}
						<td>{formatNumber(checkOf.get(row.year)?.askedMm3, 3)}</td>
					{/if}
					{#each row.months as value, k (k)}
						<td>{formatNumber(value, 2)}</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	/* A 106-year record scrolls here; the header and the year stick, so a value always has its labels. */
	.rows {
		position: relative;
		overflow: auto;
		max-height: 26rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		min-width: 0;
	}
	table {
		min-width: 46rem;
		width: 100%;
	}
	caption {
		padding-left: 0.6rem;
	}
	thead th {
		position: sticky;
		top: 0;
		z-index: 1;
	}
	th:first-child {
		position: sticky;
		left: 0;
		background: var(--surface);
	}
	thead th:first-child {
		z-index: 2;
		background: var(--surface-2);
	}
	.total {
		font-weight: 600;
	}
</style>
