<!--
	What a table's area is made of: the shares with their sum, then the rotations
	or ages and the other values of the file's lines. Each value has what the
	file holds beside it, reset, and a source note once it changes (issue #3 rule
	8). A value this screen can't change safely stays in view, without a box, and
	the reason sits above the table. Sits under its YearTable, one column each on
	a phone, side by side when there's room.
-->
<script lang="ts">
	import { scrollable } from '#lib/shell/scrollable.js';
	import { tick } from 'svelte';
	import { formatValue, type CompositionRow, type CompositionView } from './composition.js';

	let {
		view,
		onvalue,
		onnote,
		onreset
	}: {
		view: CompositionView;
		onvalue: (row: CompositionRow, text: string) => void;
		onnote: (row: CompositionRow, note: string) => void;
		onreset: (row: CompositionRow) => void;
	} = $props();

	const prefix = $derived(`composition-${view.table}`);
	const idOf = (row: CompositionRow) => `${prefix}-${row.field.field.replace(/[^A-Za-z]+/g, '-')}`;
	const unit = (row: CompositionRow) => (row.field.unit === '%' ? '%' : 'years');
	const inFile = (row: CompositionRow) => (row.file === null ? 'none' : formatValue(row.field, row.file));

	/** Reset takes its button away, so the focus goes to the value it changed. */
	async function reset(row: CompositionRow) {
		onreset(row);
		await tick();
		document.getElementById(`${idOf(row)}-value`)?.focus();
	}
</script>

{#snippet rowsOf(rows: readonly CompositionRow[])}
	{#each rows as row (row.field.field)}
		{@const id = idOf(row)}
		{@const detail = row.changed || row.error !== null || row.hint !== null || row.applied !== null}
		<tr class:changed={row.state !== 'same'} data-field={row.field.field} data-state={row.state}>
			<th scope="row">
				{row.field.label}, {unit(row)}
				{#if row.state === 'edited'}
					<span class="state">edited</span>
				{/if}
				{#if row.locked}
					<span class="state">read-only</span>
				{/if}
			</th>
			<td>
				{#if row.locked}
					<span class="held">{row.text === '' ? 'none' : row.text}</span>
				{:else}
					<input
						id={`${id}-value`}
						type="text"
						inputmode="decimal"
						autocomplete="off"
						spellcheck="false"
						value={row.text}
						aria-label={`${row.field.label}, ${unit(row)}`}
						aria-invalid={row.error ? 'true' : undefined}
						aria-describedby={row.error ? `${id}-msg` : undefined}
						oninput={(e) => onvalue(row, e.currentTarget.value)}
					/>
				{/if}
			</td>
			<td class="file">{inFile(row)}</td>
			<td class="acts">
				{#if !row.locked && row.target !== row.file && row.file !== null}
					<button type="button" onclick={() => reset(row)}>Reset<span class="sr"> {row.field.label.toLowerCase()} to {inFile(row)}</span></button>
				{/if}
			</td>
		</tr>
		{#if detail}
			<tr class="detail" data-for={row.field.field}>
				<td colspan="4">
					{#if row.applied}
						<p class="said">{row.applied}</p>
					{/if}
					{#if row.needsNote}
						<label class="why" for={`${id}-note`}>
							<span>Where the {row.field.label.toLowerCase()} came from (required)</span>
							<input id={`${id}-note`} type="text" autocomplete="off" required aria-required="true" value={row.note} oninput={(e) => onnote(row, e.currentTarget.value)} />
						</label>
					{:else if row.backToFile}
						<p class="said">Back to the network file’s value, so no source is needed.</p>
					{/if}
					{#if row.error}
						<p id={`${id}-msg`} class="msg error">{row.error}</p>
					{/if}
					{#if row.hint}
						<p class="said">{row.hint}</p>
					{/if}
				</td>
			</tr>
		{/if}
	{/each}
{/snippet}

{#snippet head()}
	<thead>
		<tr>
			<th scope="col">Value</th>
			<th scope="col">Now</th>
			<th scope="col">In the file</th>
			<th scope="col"><span class="sr">Actions</span></th>
		</tr>
	</thead>
{/snippet}

<section class="composition" aria-labelledby={`${prefix}-h`} data-composition={view.table}>
	<h4 id={`${prefix}-h`}>{view.title}</h4>
	{#if view.targets}
		<p class="targets" data-targets>{view.targets}</p>
	{/if}
	{#each view.locks as lock (lock)}
		<p class="warn" data-lock>{lock}</p>
	{/each}
	<div class="tables">
		<div class="scroll" use:scrollable>
			<table class="data">
				<caption>Shares of the area. {view.origin}, unless a row says otherwise.</caption>
				{@render head()}
				<tbody>
					{@render rowsOf(view.shares)}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row" colspan="4" class="sum" class:off={!view.sum.ok} data-sum-ok={view.sum.ok}>{view.sum.text}</th>
					</tr>
				</tfoot>
			</table>
		</div>
		<div class="scroll" use:scrollable>
			<table class="data">
				<caption>The other values. {view.origin}, unless a row says otherwise.</caption>
				{@render head()}
				<tbody>
					{@render rowsOf(view.others)}
				</tbody>
			</table>
		</div>
	</div>
	{#each view.notes as note (note)}
		<p class="note">{note}</p>
	{/each}
</section>

<style>
	.composition {
		margin-top: 1rem;
	}
	h4 {
		margin: 0 0 0.25rem;
	}
	.targets {
		margin: 0 0 0.5rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.composition > .note {
		margin: 0.35rem 0 0;
		font-size: var(--font-sm);
	}
	.tables {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem 1.5rem;
		align-items: start;
	}
	@media (min-width: 62rem) {
		.tables {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	table {
		width: 100%;
		font-size: var(--font-sm);
	}
	caption {
		text-align: left;
		color: var(--text-muted);
		padding-bottom: 0.25rem;
	}
	tbody th,
	tbody td {
		vertical-align: middle;
	}
	tbody th {
		font-weight: 600;
		text-align: left;
		white-space: normal;
	}
	tr.changed > th {
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.state {
		display: block;
		font-size: var(--font-xs);
		font-weight: 400;
		color: var(--text-muted);
	}
	td input {
		width: 6rem;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.held,
	.file {
		font-variant-numeric: tabular-nums;
	}
	.file {
		color: var(--text-muted);
	}
	.acts {
		white-space: nowrap;
	}
	.acts button {
		padding: 0 0.5rem;
	}
	table.data .sum {
		text-align: left;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	table.data .sum.off {
		color: var(--danger);
	}
	/* The line under a changed row: it wraps, left-aligned, across the whole table. */
	table.data td[colspan='4'] {
		white-space: normal;
		text-align: left;
		padding-top: 0;
	}
	.detail td {
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.why {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-weight: 600;
	}
	.why input {
		width: 100%;
		text-align: left;
	}
	.said,
	.msg {
		margin: 0.15rem 0;
	}
	.said {
		color: var(--text-muted);
	}
	/* Four columns fit a phone once the padding goes and the boxes narrow. */
	@media (max-width: 30rem) {
		table.data th,
		table.data td {
			padding-inline: 0.25rem;
		}
		td input {
			width: 4.75rem;
		}
	}
</style>
