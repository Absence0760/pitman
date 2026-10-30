<!--
	One land-use table: its years and values to edit, with the file's value,
	reset and a source note on every changed value, and its chart beside it.
	The value is a row of four short columns, so the table fits a phone; what a
	changed row needs (the note, a refusal, how a run reads it) takes the line
	under it at the table's full width. State is in words as well as the edge.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { hydroYearLabel } from '#lib/results/format.js';
	import { seriesChart } from './chart.js';
	import type { TableOffer } from './offers.js';
	import { addYearProblem, canRemove, formatCell, suggestedYear, type RowState, type RowView } from './review.js';
	import SeriesChart from './SeriesChart.svelte';

	let {
		offer,
		rows,
		run,
		areaKm2,
		onvalue,
		onnote,
		onreset,
		onremove,
		onputback,
		onadd
	}: {
		offer: TableOffer;
		rows: readonly RowView[];
		run: { readonly startYear: number; readonly endYear: number };
		/** The module's area, to say a paved fraction in km². */
		areaKm2: number;
		onvalue: (row: RowView, text: string) => void;
		onnote: (row: RowView, note: string) => void;
		onreset: (row: RowView) => void;
		onremove: (row: RowView) => void;
		onputback: (row: RowView) => void;
		onadd: (year: number) => void;
	} = $props();

	const prefix = $derived(`tables-${offer.table}`);
	const lines = $derived(`${offer.format.yearsLine}–${offer.format.valuesLine}`);
	const spec = $derived(seriesChart(`${prefix}-chart`, offer.table, offer.title, offer.valueLabel, rows, run));
	const removable = $derived(canRemove(offer.table, rows));
	const onlyOne = $derived(!removable && rows.some((r) => r.target !== null && r.state !== 'new'));

	const STATE_WORDS: Readonly<Record<RowState, string>> = { same: '', edited: 'edited', new: 'new', removing: 'to remove', removed: 'removed' };

	let typedYear = $state<string | null>(null);
	const yearText = $derived(typedYear ?? String(suggestedYear(rows)));
	const problem = $derived(addYearProblem(rows, yearText));
	let tried = $state(false);

	const focus = async (id: string) => {
		await tick();
		document.getElementById(id)?.focus();
	};

	function add() {
		tried = true;
		if (problem !== null) return;
		const year = Number(yearText.trim());
		onadd(year);
		typedYear = null;
		tried = false;
		void focus(`${prefix}-${year}-value`);
	}

	function remove(row: RowView) {
		onremove(row);
		void focus(row.current === null ? `${prefix}-add` : `${prefix}-${row.year}-back`);
	}

	function back(row: RowView) {
		onputback(row);
		void focus(`${prefix}-${row.year}-value`);
	}

	const inFile = (value: number | null) => (value === null ? 'none' : formatCell(offer.table, value));
</script>

<article class="block" aria-labelledby={`${prefix}-h`}>
	<h3 id={`${prefix}-h`}>{offer.title}</h3>
	{#if offer.facts}
		<p class="note facts-line">{offer.facts}</p>
	{/if}
	{#each offer.notes as note (note)}
		<p class="warn">{note}</p>
	{/each}
	{#if offer.why && rows.length > 0}
		<p class="warn">{offer.why}</p>
	{/if}

	<div class="work">
		<div class="editing">
			{#if rows.length === 0}
				<p class="note">No years in this table. {offer.open ? 'Add one below.' : ''}</p>
			{:else}
				<div class="scroll rows">
					<table class="data">
						<caption>{offer.origin}, unless a row says otherwise.</caption>
						<thead>
							<tr>
								<th scope="col">Year</th>
								<th scope="col">{offer.valueLabel}</th>
								<th scope="col">In the file</th>
								<th scope="col"><span class="sr">Actions</span></th>
							</tr>
						</thead>
						<tbody>
							{#each rows as row, i (offer.open ? row.year : i)}
								{@const id = `${prefix}-${row.year}`}
								{@const gone = row.state === 'removing' || row.state === 'removed'}
								{@const detail = row.changed || row.error !== null || row.hint !== null || row.applied !== null || row.state === 'removed'}
								<tr class:changed={row.state !== 'same'} class:gone data-year={row.year} data-state={row.state}>
									<th scope="row">
										<span class="year">{row.year}</span>
										{#if STATE_WORDS[row.state]}
											<span class="state">{STATE_WORDS[row.state]}</span>
										{/if}
									</th>
									<td>
										{#if gone}
											<s>{inFile(row.current ?? row.file)}</s>
										{:else}
											{#if offer.open}
												<input
													id={`${id}-value`}
													type="text"
													inputmode="decimal"
													autocomplete="off"
													spellcheck="false"
													value={row.text}
													aria-label={`${offer.valueLabel} in ${row.year}`}
													aria-invalid={row.error ? 'true' : undefined}
													aria-describedby={row.error ? `${id}-msg` : undefined}
													oninput={(e) => onvalue(row, e.currentTarget.value)}
												/>
											{:else}
												{row.text}
											{/if}
											{#if offer.table === 'paved' && row.target !== null}
												<span class="sub">{(row.target * areaKm2).toFixed(1)} km²</span>
											{/if}
										{/if}
									</td>
									<td class="file">{inFile(row.file)}</td>
									<td class="acts">
										{#if gone}
											<button type="button" id={`${id}-back`} disabled={!offer.open} onclick={() => back(row)}>Put back<span class="sr"> {row.year}</span></button>
										{:else if offer.open}
											{#if row.state !== 'new' && row.target !== row.file}
												<button type="button" onclick={() => onreset(row)}>Reset<span class="sr"> {row.year} to {inFile(row.file)}</span></button>
											{/if}
											<button type="button" disabled={!removable && row.state !== 'new'} onclick={() => remove(row)}>Remove<span class="sr"> {row.year}</span></button>
										{/if}
									</td>
								</tr>
								{#if detail}
									<tr class="detail" class:gone data-for={row.year}>
										<td colspan="4">
											{#if row.applied}
												<p class="said">{row.applied}</p>
											{/if}
											{#if row.state === 'removed'}
												<p class="said">Removed from the table. Put it back to restore the file’s {inFile(row.file)}.</p>
											{/if}
											{#if row.needsNote}
												<label class="why" for={`${id}-note`}>
													<span>{row.state === 'removing' ? `Why ${row.year} goes (required)` : `Where ${row.year}’s value came from (required)`}</span>
													<input id={`${id}-note`} type="text" autocomplete="off" required aria-required="true" value={row.note} oninput={(e) => onnote(row, e.currentTarget.value)} />
												</label>
											{:else if row.backToFile}
												<p class="said">Back to the network file’s value, so no source is needed.</p>
											{/if}
											{#if row.error}
												<p id={`${id}-msg`} class="msg" class:error={row.text.trim() !== ''}>{row.error}</p>
											{/if}
											{#if row.hint}
												<p class="said">{row.hint}</p>
											{/if}
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
				<p class="note years">Years are hydrological: {rows[0]?.year} is {hydroYearLabel(rows[0]?.year ?? 0)}, October to September.</p>
			{/if}

			{#if onlyOne}
				<p class="note">The last year can’t be removed: {offer.table === 'afforestation' ? 'the species split (L.009–L.010)' : 'the composition (L.014–L.015)'} is in the file only while the table has a row. Set it to 0 if the area has gone.</p>
			{/if}

			{#if offer.open}
				<div class="add">
					<label for={`${prefix}-add`}>Add a year</label>
					<div class="line">
						<input
							id={`${prefix}-add`}
							type="text"
							inputmode="numeric"
							autocomplete="off"
							maxlength="4"
							value={yearText}
							aria-invalid={tried && problem ? 'true' : undefined}
							aria-describedby={tried && problem ? `${prefix}-add-msg` : undefined}
							oninput={(e) => {
								typedYear = e.currentTarget.value;
								tried = false;
							}}
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									add();
								}
							}}
						/>
						<button type="button" onclick={add}>Add {problem === null ? yearText.trim() : 'year'}</button>
					</div>
					{#if tried && problem}
						<p id={`${prefix}-add-msg`} class="msg error">{problem}</p>
					{/if}
				</div>
			{/if}
		</div>

		{#if spec}
			<div class="charting">
				<SeriesChart {spec} {rows} />
			</div>
		{/if}
	</div>
</article>

<style>
	.block {
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
		margin-top: 1rem;
	}
	h3 {
		margin: 0 0 0.25rem;
	}
	.facts-line {
		margin: 0 0 0.5rem;
		font-size: var(--font-sm);
	}
	.work {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem 1.5rem;
		margin-top: 0.5rem;
	}
	@media (min-width: 62rem) {
		.work {
			grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
			align-items: start;
		}
	}
	.editing,
	.charting {
		min-width: 0;
	}
	/* A long table scrolls in its box, its header in view. */
	.rows {
		max-height: 30rem;
		overflow: auto;
	}
	.rows thead th {
		position: sticky;
		top: 0;
		z-index: 1;
		white-space: normal;
		vertical-align: bottom;
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
	tr.changed > th {
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.year {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.state {
		display: block;
		font-size: var(--font-xs);
		color: var(--text-muted);
	}
	td input {
		width: 6.5rem;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.sub {
		display: block;
		font-size: var(--font-xs);
		color: var(--text-muted);
	}
	.file {
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}
	.acts {
		white-space: nowrap;
	}
	.acts button {
		padding: 0 0.5rem;
	}
	.acts button + button {
		margin-left: 0.25rem;
	}
	/* Four short columns fit a phone once the two buttons stack and the padding goes. */
	@media (max-width: 30rem) {
		table.data th,
		table.data td {
			padding-inline: 0.25rem;
		}
		td input {
			width: 4.75rem;
		}
		.acts button {
			display: block;
			width: 100%;
		}
		.acts button + button {
			margin: 0.25rem 0 0;
		}
	}
	tr.gone s {
		color: var(--text-muted);
	}
	/* The line under a changed row: it wraps, left-aligned, across the whole table. */
	table.data td[colspan] {
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
	.years {
		margin: 0.35rem 0 0;
		font-size: var(--font-sm);
	}
	.add {
		margin-top: 0.75rem;
	}
	.add label {
		display: block;
		font-weight: 650;
		margin-bottom: 0.2rem;
	}
	.line {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.line input {
		width: 5.5rem;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.add .msg {
		font-size: var(--font-sm);
	}
</style>
