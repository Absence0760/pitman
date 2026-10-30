<!--
	Land-use tables: pick a runoff module and edit its afforestation, alien
	vegetation and paved year tables in place, with a source for every changed
	value (issue #3 rule 8) and a chart of each series. Edits stay a preview
	until they are applied; applying hands the page an updated bundle
	(`onupdate`), and the sidecar logs each change. Logic is in the .ts files
	beside this one. docs/user-guide.md § Land-use tables.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { applyTableEdits, type LandUseTable, type LoadedBundle, type RunoffModule } from '@pitman/wrsm';
	import { plural } from '#lib/network/format.js';
	import { coverageSummary, moduleChoices, moduleLabel, moduleRole, pieceOrigin, TABLE_ORDER, tableOffer } from './offers.js';
	import { changeLine, fillNotes, putBack, refusedRows, removeRow, resetRow, reviewModule, toEdits, type ModuleDraft, type RowView, type TableDraft } from './review.js';
	import YearTable from './YearTable.svelte';

	let {
		bundle,
		onupdate,
		onrerun,
		busy = false
	}: {
		bundle: LoadedBundle;
		/** The working copy changed: the page replaces its bundle, stores it and says `status`. */
		onupdate: (next: LoadedBundle, status: string) => void;
		/** Run the network again (the page's Run, with the modes chosen there). */
		onrerun: () => void;
		/** A run is in progress: no apply until it finishes. */
		busy?: boolean;
	} = $props();

	const choices = $derived(moduleChoices(bundle));
	const runoffOf = (number: number | undefined) => bundle.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === number);

	let selected = $state<number | undefined>();
	const module = $derived(runoffOf(selected));
	const role = $derived(module ? moduleRole(bundle, module) : undefined);
	const fileName = $derived(module ? (bundle.files.modules[`RU${module.number}`] ?? `RU ${module.number}`) : '');
	const offers = $derived(module ? TABLE_ORDER.map((table) => tableOffer(bundle, module, table, fileName)) : []);
	const hiddenOffers = $derived(offers.filter((o) => !o.shown));
	const piece = $derived(module ? pieceOrigin(bundle.sidecar, module.number) : undefined);

	/** Drafts by module: picking another module keeps what was typed. */
	let drafts = $state.raw<Readonly<Record<number, ModuleDraft>>>({});
	const draft = $derived(selected === undefined ? {} : (drafts[selected] ?? {}));
	const review = $derived(module ? reviewModule(bundle, module, draft) : null);
	const waiting = $derived(
		Object.keys(drafts)
			.map(Number)
			.flatMap((number) => {
				const other = number === selected ? undefined : runoffOf(number);
				const count = other ? reviewModule(bundle, other, drafts[number] ?? {}).changes.length : 0;
				return other && count > 0 ? [{ number, label: moduleLabel(other), count }] : [];
			})
	);

	/** A refusal stays in view at Apply, however long the table holding its row. */
	const refused = $derived(review ? refusedRows(review) : []);
	/** What stops Apply, in one always-present live region: a refusal appears beside a box that keeps the focus. */
	const blocked = $derived(review === null ? '' : ([...refused, ...review.errors, ...(review.missingNotes > 0 ? [`${plural(review.missingNotes, 'value')} still ${review.missingNotes === 1 ? 'needs' : 'need'} a source.`] : [])][0] ?? ''));
	const canApply = $derived(review !== null && review.changes.length > 0 && review.valid && review.missingNotes === 0 && review.saved.problem === null && !busy);

	let applied = $state<string | undefined>();
	let sharedNote = $state('');

	function choose(value: string) {
		selected = value === '' ? undefined : Number(value);
		applied = undefined;
		sharedNote = '';
	}

	async function open(number: number) {
		choose(String(number));
		await tick();
		document.getElementById('tables-module')?.focus();
	}

	function setDraft(next: ModuleDraft) {
		if (selected === undefined) return;
		drafts = { ...drafts, [selected]: next };
		applied = undefined;
	}

	const setTable = (table: LandUseTable, next: TableDraft) => setDraft({ ...draft, [table]: next });
	const tableDraft = (table: LandUseTable): TableDraft => draft[table] ?? {};

	function setValue(table: LandUseTable, row: RowView, text: string) {
		setTable(table, { ...tableDraft(table), [row.year]: { text, note: row.note } });
	}

	function setNote(table: LandUseTable, row: RowView, note: string) {
		setTable(table, { ...tableDraft(table), [row.year]: { ...(tableDraft(table)[row.year] ?? { text: row.text }), note } });
	}

	function resetAll() {
		if (!review) return;
		let next: ModuleDraft = draft;
		for (const table of TABLE_ORDER) {
			next = { ...next, [table]: review.tables[table].reduce((d, row) => resetRow(d, table, row), next[table] ?? {}) };
		}
		setDraft(next);
	}

	function useSharedNote() {
		if (!review || sharedNote.trim() === '') return;
		setDraft(fillNotes(draft, review, sharedNote.trim()));
		sharedNote = '';
	}

	async function apply() {
		if (!module || !review || !canApply) return;
		const text = `Applied ${plural(review.changes.length, 'change')} to RU ${module.number}: ${review.changes.map(changeLine).join('; ')}.`;
		const next = applyTableEdits(bundle, toEdits(module, review.changes, new Date().toISOString()));
		const { [module.number]: _done, ...rest } = drafts;
		drafts = rest;
		sharedNote = '';
		applied = text;
		onupdate(next, text);
		await tick();
		document.getElementById('tables-applied')?.focus();
	}
</script>

<section aria-labelledby="tables-h" class="card">
	<h2 id="tables-h">Land-use tables</h2>
	<p>
		Bring a runoff module’s afforestation, alien vegetation and paved area up to date, each new value with where it came from. Nothing changes in the working copy until you apply it.
	</p>

	{#if choices.length === 0}
		<p class="note">This network has no runoff modules.</p>
	{:else}
		<p class="note">{coverageSummary(choices)}</p>
		<div class="pick">
			<label for="tables-module">Runoff module</label>
			<select id="tables-module" value={selected ?? ''} onchange={(e) => choose(e.currentTarget.value)}>
				<option value="">Choose a module</option>
				{#each choices as c (c.number)}
					<option value={c.number}>{c.label}</option>
				{/each}
			</select>
		</div>
	{/if}

	<p class="sr" role="status" data-live>{blocked}</p>

	{#if waiting.length > 0}
		<div class="waiting">
			<p>Not applied yet:</p>
			{#each waiting as w (w.number)}
				<button type="button" onclick={() => open(w.number)}>{w.label} ({plural(w.count, 'change')})</button>
			{/each}
		</div>
	{/if}

	{#if applied}
		<div class="applied" id="tables-applied" tabindex="-1" role="status">
			<p><strong>Applied to the working copy.</strong> {applied}</p>
			<p>It’s recorded in <code>pitman.json</code> with the value it replaced and its source, and goes out with the next save. The old results were cleared.</p>
			<div class="actions">
				<button type="button" class="primary" onclick={onrerun} disabled={busy}>Rerun the network</button>
			</div>
		</div>
	{/if}

	{#if module && review}
		<dl class="facts provenance">
			<div><dt>Catchment</dt><dd>{module.areaKm2} km²</dd></div>
			<div>
				<dt>Role</dt>
				<dd>
					{#if role?.kind === 'parent'}
						SFR parent of {plural(role.children.length, 'child', 'children')}
					{:else if role?.kind === 'child'}
						SFR child of RU {role.parent.number}
					{:else}
						Free module
					{/if}
				</dd>
			</div>
			<div><dt>Tables read from</dt><dd>{fileName}, L.006–L.018</dd></div>
			{#if piece}
				<div><dt>Sub-division</dt><dd>Piece of {piece.quaternary}, from RU {piece.original}</dd></div>
			{/if}
		</dl>

		{#if role?.kind === 'child'}
			<p class="note">
				This is an SFR child. Calibrate sends you to its parent, because its parameters are RU {role.parent.number}’s; its land-use table is its own, so it is edited here. A run reads it as the child’s active area and takes that area off RU {role.parent.number} year by year.
				<button type="button" class="link" onclick={() => role?.kind === 'child' && open(role.parent.number)}>Open RU {role.parent.number}</button>
			</p>
		{:else if role?.kind === 'parent'}
			<div class="note">
				<p>This is an SFR parent. Its afforestation and alien vegetation are in its children’s tables, and a run takes the children’s areas off this module year by year.</p>
				<div class="children">
					{#each role.children as child (child.number)}
						<button type="button" onclick={() => open(child.number)}>Open {moduleLabel(child)}</button>
					{/each}
				</div>
			</div>
		{/if}

		<p class="note">
			A run reads each table as a straight line between the listed years, flat before the first and after the last, with one value for the whole hydrological year. Present-day mode holds each table at its chosen year; natural mode leaves them out.
		</p>

		{#each hiddenOffers as offer (offer.table)}
			<p class="note"><strong>{offer.title}:</strong> {offer.why}</p>
		{/each}

		{#each offers.filter((o) => o.shown) as offer (offer.table)}
			<YearTable
				{offer}
				rows={review.tables[offer.table]}
				run={bundle.network}
				areaKm2={module.areaKm2}
				onvalue={(row, text) => setValue(offer.table, row, text)}
				onnote={(row, note) => setNote(offer.table, row, note)}
				onreset={(row) => setTable(offer.table, resetRow(tableDraft(offer.table), offer.table, row))}
				onremove={(row) => setTable(offer.table, removeRow(tableDraft(offer.table), row))}
				onputback={(row) => setTable(offer.table, putBack(tableDraft(offer.table), offer.table, row))}
				onadd={(year) => setTable(offer.table, { ...tableDraft(offer.table), [year]: { text: '', note: '' } })}
			/>
		{/each}

		{#if review.changes.length > 0 || refused.length > 0}
			<div class="pending">
				<p><strong>Preview only:</strong> results and a save keep the earlier values until you apply.</p>
				<ul class="list">
					{#each review.changes as change (`${change.table}-${change.year}`)}
						<li>{changeLine(change)}</li>
					{/each}
				</ul>
				{#each [...refused, ...review.errors] as text (text)}
					<p class="error">{text}</p>
				{/each}
				{#each review.warnings as text (text)}
					<p class="warn">{text}</p>
				{/each}
				{#if review.saved.rounded.length > 0}
					<p class="warn">Saving rewrites this module’s file, which rounds {review.saved.rounded.join(', ')}: the loaded file held more decimals than WRSM2000’s format keeps.</p>
				{/if}
				{#if review.saved.problem}
					<p class="error">The module can’t be written: {review.saved.problem}</p>
				{/if}
				{#if review.missingNotes > 0}
					<p>{plural(review.missingNotes, 'value')} still {review.missingNotes === 1 ? 'needs' : 'need'} a source.</p>
					<div class="share">
						<label for="tables-shared">Same source for all of them</label>
						<div class="line">
							<input id="tables-shared" type="text" autocomplete="off" bind:value={sharedNote} />
							<button type="button" onclick={useSharedNote} disabled={sharedNote.trim() === ''}>Use for {plural(review.missingNotes, 'value')}</button>
						</div>
					</div>
				{/if}
				<div class="actions">
					<button type="button" class="primary" onclick={apply} disabled={!canApply}>Apply to the working copy</button>
					<button type="button" onclick={resetAll}>Reset all to the file</button>
				</div>
				{#if busy}
					<p class="note">Wait for the run to finish.</p>
				{/if}
			</div>
		{:else if Object.values(review.tables).flat().some((r) => r.current !== r.file)}
			<div class="actions">
				<button type="button" onclick={resetAll}>Reset all to the file</button>
			</div>
		{/if}
	{/if}
</section>

<style>
	.pick {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		margin: 0.5rem 0;
	}
	.pick label,
	.share label {
		font-weight: 650;
	}
	.pick select {
		width: 100%;
	}
	.waiting {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0.5rem 0;
	}
	.waiting p {
		margin: 0;
		font-weight: 600;
	}
	.children {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.25rem 0 0.75rem;
	}
	.link {
		margin-left: 0.25rem;
	}
	.pending {
		border-left: 4px solid var(--warning);
		background: var(--warning-soft);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem 0.75rem;
		margin-top: 1rem;
	}
	.pending p {
		margin: 0 0 0.35rem;
	}
	.pending .warn {
		background: transparent;
		padding-left: 0.5rem;
	}
	.list {
		margin: 0 0 0.5rem;
		padding-left: 1.25rem;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}
	.share {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: var(--font-sm);
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.line input {
		flex: 1 1 14rem;
		min-width: 0;
	}
	.pending .actions {
		margin-top: 0.75rem;
	}
</style>
