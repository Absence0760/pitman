<!--
	Demands: the network's demand and defined-flow files with what each attaches
	to, and the form that makes one from an annual volume, monthly shares and
	growth (DemandEditor.svelte, docs/formats.md § 12). A file with a spec in
	pitman.json can be edited; one without can be viewed and replaced, because
	a spec can't be recovered from monthly rows. Applying hands the page an
	updated bundle (`onupdate`), as the extension does. Any file can be removed:
	the confirmation shows the engine's plan (`planDemandRemoval`) and carries it
	out, and Undo gives the page back the bundle from before.
-->
<script lang="ts">
	import { scrollable } from '#lib/shell/scrollable.js';
	import { tick } from 'svelte';
	import { applyDemand, applyDemandRemoval, demandRemovals, demandSourcesOf, planDemandRemoval, type DemandPlan, type DemandRouteChoice, type LoadedBundle } from '@pitman/wrsm';
	import { plural } from '#lib/network/format.js';
	import { formatNumber, hydroYearLabel } from '#lib/results/format.js';
	import DemandEditor from './DemandEditor.svelte';
	import { draftFromFile, draftFromSpec, newDraft, type DemandDraft } from './draft.js';
	import { attachmentLabel, demandFiles, removalConsequences, removalRoutes, sourceLabel, type DemandFileRow } from './files.js';
	import MonthlyRows from './MonthlyRows.svelte';

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

	/** What is open under the list: one file's rows, or the form with its starting values. */
	type Open = { readonly kind: 'view'; readonly key: string } | { readonly kind: 'edit'; readonly key: string | null; readonly start: DemandDraft; readonly run: number };

	const files = $derived(demandFiles(bundle));
	const short = $derived(files.filter((f) => f.shortfall !== null));
	let open = $state.raw<Open | undefined>();
	let run = 0;
	const entry = $derived(open?.key == null ? undefined : files.find((f) => f.key === open?.key));
	const viewed = $derived(open?.kind === 'view' && entry ? bundle.flowFiles[entry.key] : undefined);
	let applied = $state<string | undefined>();

	/** The file a confirmation is open on, and which route of a shared file it takes it off; none is all of them. */
	let removing = $state<string | undefined>();
	let onlyRoute = $state('');
	let removeWhy = $state('');
	const removingFile = $derived(files.find((f) => f.key === removing));
	const routeChoices = $derived(removingFile?.attachments ?? []);
	const choiceId = (a: DemandRouteChoice) => `${a.module.type}${a.module.number}-${a.route}-${a.direction}`;
	const removal = $derived(removingFile ? planDemandRemoval(bundle, removingFile.key, routeChoices.find((a) => choiceId(a) === onlyRoute)) : undefined);
	const removeBlocked = $derived(removal === undefined || removal.refused !== null || busy || (removal.needsReason && removeWhy.trim() === ''));

	/** What the last removal did, with the bundle from before it: Undo lasts until the network moves on. */
	type Removed = { readonly text: string; readonly fileGoes: boolean; readonly before: LoadedBundle; readonly after: LoadedBundle; readonly undone: boolean };
	let removed = $state.raw<Removed | undefined>();
	const removals = $derived(demandRemovals(bundle.sidecar));

	const slug = (key: string) => key.replace(/[^A-Za-z0-9]+/g, '-');

	async function focus(id: string) {
		await tick();
		document.getElementById(id)?.focus();
	}

	function editFile(file: DemandFileRow) {
		const series = bundle.flowFiles[file.key];
		if (series === undefined) return;
		const start = file.spec ? draftFromSpec(file.spec, demandSourcesOf(bundle, file.key), bundle.network) : draftFromFile(series);
		open = { kind: 'edit', key: file.key, start, run: ++run };
		applied = undefined;
		void focus('demand-editor-h');
	}

	function viewFile(file: DemandFileRow) {
		open = { kind: 'view', key: file.key };
		applied = undefined;
		void focus('demand-view-h');
	}

	function create() {
		open = { kind: 'edit', key: null, start: newDraft(bundle.network), run: ++run };
		applied = undefined;
		void focus('demand-editor-h');
	}

	function close() {
		const key = open?.key;
		open = undefined;
		void focus(key ? `demand-pick-${slug(key)}` : 'demand-new');
	}

	function askRemove(file: DemandFileRow) {
		removing = file.key;
		onlyRoute = '';
		removeWhy = '';
		void focus('demand-remove-keep');
	}

	function keepFile() {
		const key = removing;
		removing = undefined;
		void focus(key ? `demand-remove-${slug(key)}` : 'demand-new');
	}

	function remove() {
		if (!removal || removeBlocked) return;
		const summary = `${removal.fileName}${removal.routes.length === 0 ? '' : ` off ${removalRoutes(removal)}`}`;
		const source = removal.needsReason ? { kind: 'manual' as const, note: removeWhy.trim(), date: new Date().toISOString() } : undefined;
		const next = applyDemandRemoval(bundle, removal, source);
		if (removal.fileGoes && open?.key === removal.key) open = undefined;
		removed = { text: summary, fileGoes: removal.fileGoes, before: bundle, after: next, undone: false };
		removing = undefined;
		applied = undefined;
		onupdate(next, `Demand removed: ${summary}. Run again to see its effect.`);
		void focus('demand-removed');
	}

	function undoRemoval() {
		if (!removed) return;
		const { text, before } = removed;
		removed = { ...removed, undone: true };
		onupdate(before, `Removal undone: ${text}. Run again to see its effect.`);
		void focus('demand-removed');
	}

	function onapply(plan: DemandPlan) {
		const where = plan.attach ? ` on ${plan.attach.module.type} ${plan.attach.module.number} route ${plan.attach.route}` : '';
		const summary = `${plan.fileName}${where}: ${hydroYearLabel(plan.firstYear)} to ${hydroYearLabel(plan.lastYear)}.`;
		onupdate(applyDemand(bundle, plan), `Demand applied: ${summary} Run again to see its effect.`);
		applied = summary;
		removed = undefined;
		open = undefined;
		void focus('demand-applied');
	}
</script>

<section aria-labelledby="demand-h" class="card">
	<h2 id="demand-h">Demands</h2>
	<p>
		The demand and defined-flow files on this network’s routes, mostly domestic supply. Make one from an annual volume, a monthly distribution and growth to 2025 and
		beyond; Pitman writes it in WRSM2000’s format, one row per year, and records how it was made in <code>pitman.json</code>. Remove one you no longer want, the network’s own
		included; the confirmation says what happens to its routes.
	</p>

	{#if files.length === 0}
		<p class="note">This network has no demand files yet.</p>
	{:else}
		<div class="scroll" use:scrollable>
			<table class="files" aria-label="Demand files">
				<thead>
					<tr>
						<th scope="col">File</th>
						<th scope="col">Attached to</th>
						<th scope="col">Years</th>
						<th scope="col" class="number">Mean annual, million m³/a</th>
						<th scope="col">Where it came from</th>
						<th scope="col"><span class="sr">Action</span></th>
					</tr>
				</thead>
				<tbody>
					{#each files as f (f.key)}
						<tr data-file={f.key}>
							<th scope="row">{f.name}</th>
							<td>
								{#if f.attachments.length === 0}
									<span class="sub">Nothing reads it</span>
								{/if}
								{#each f.attachments as a (`${a.module.type}${a.module.number}-${a.route}-${a.direction}`)}
									<span class="attachment">{attachmentLabel(a)}</span>
								{/each}
							</td>
							<td class="years">
								{hydroYearLabel(f.firstYear)} to {hydroYearLabel(f.lastYear)}
								{#if f.shortfall}
									<span class="short">Short of the run</span>
								{/if}
							</td>
							<td class="number">{formatNumber(f.meanAnnualMm3, 2)}</td>
							<td>
								{#if f.spec}
									{sourceLabel(demandSourcesOf(bundle, f.key).annualVolume)}
									{#if f.specStale}
										<span class="short">Rows changed outside Pitman</span>
									{/if}
								{:else}
									The file as loaded
									<span class="sub">No spec: view, replace or remove</span>
								{/if}
							</td>
								<td class="acts">
								<button
									type="button"
									id={`demand-pick-${slug(f.key)}`}
									onclick={() => (f.spec ? editFile(f) : viewFile(f))}
									aria-pressed={open?.key === f.key}
									disabled={busy}
								>
									{f.spec ? 'Edit' : 'View'}<span class="sr"> {f.name}</span>
								</button>
								<button type="button" id={`demand-remove-${slug(f.key)}`} onclick={() => askRemove(f)} aria-pressed={removing === f.key} disabled={busy}>Remove<span class="sr"> {f.name}</span></button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#each short as f (f.key)}
			<p class="warn">{f.name}: {f.shortfall} {f.spec ? 'Edit it and apply to regenerate it for the run.' : 'View it and replace it, or load a file that reaches the run’s last year.'}</p>
		{/each}
		<p class="note">{plural(files.length, 'file')}. Volumes are million m³; a year is a hydrological year, October to September, so 2025/26 starts in October 2025.</p>
	{/if}

	{#if removingFile && removal}
		<div class="warn confirm" role="alert" data-removing={removingFile.key}>
			<p><strong>Remove {removal.fileName}?</strong></p>
			{#if routeChoices.length > 1}
				<fieldset>
					<legend>{plural(routeChoices.length, 'route')} read this file</legend>
					<label class="choice"><input type="radio" name="demand-remove-route" value="" bind:group={onlyRoute} /> All of them: the file goes</label>
					{#each routeChoices as a (choiceId(a))}
						<label class="choice"><input type="radio" name="demand-remove-route" value={choiceId(a)} bind:group={onlyRoute} /> Only {attachmentLabel(a)}: the file stays on the rest</label>
					{/each}
				</fieldset>
			{/if}
			<ul>
				{#each removalConsequences(removal) as line (line)}
					<li>{line}</li>
				{/each}
			</ul>
			{#if removal.refused}
				<p class="error">{removal.refused}</p>
			{:else if removal.needsReason}
				<label class="why" for="demand-remove-why">
					<span>Why it goes (required)</span>
					<input id="demand-remove-why" type="text" autocomplete="off" required aria-required="true" bind:value={removeWhy} />
				</label>
			{/if}
			<div class="actions">
				<button type="button" id="demand-remove-keep" onclick={keepFile}>Keep it</button>
				{#if !removal.refused}
					<button type="button" onclick={remove} disabled={removeBlocked} data-remove-confirm>{removal.fileGoes ? `Remove ${removal.fileName}` : `Take it off ${removalRoutes(removal)}`}</button>
				{/if}
			</div>
			{#if busy}
				<p class="note">Wait for the run to finish.</p>
			{/if}
		</div>
	{/if}

	{#if removals.length > 0}
		<div class="removals">
			<p><strong>Removed from this network</strong>, as <code>pitman.json</code> records it:</p>
			<ul>
				{#each removals as r, k (k)}
					<li>{r.date.slice(0, 10)}: {r.note}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<div class="actions">
		<button type="button" id="demand-new" onclick={create} disabled={busy}>New demand</button>
	</div>

	{#if removed}
		<div class="applied" id="demand-removed" tabindex="-1" role="status">
			{#if removed.undone}
				<p><strong>Put back.</strong> {removed.text} is undone: the working copy is as it was before the removal. The old results were cleared.</p>
			{:else}
				<p><strong>Removed.</strong> {removed.text}. {removed.fileGoes ? 'It is out of the working copy, and the next save goes without it.' : 'The file stays on its other routes, and the next save keeps it for them.'} The old results were cleared.</p>
			{/if}
			<div class="actions">
				<button type="button" class="primary" onclick={onrerun} disabled={busy}>Rerun the network</button>
				{#if !removed.undone && bundle === removed.after}
					<button type="button" onclick={undoRemoval} disabled={busy}>Undo the removal</button>
				{/if}
			</div>
			{#if !removed.undone && bundle !== removed.after}
				<p class="note">Undo has gone, because the network has changed since.</p>
			{/if}
		</div>
	{/if}

	{#if applied}
		<div class="applied" id="demand-applied" tabindex="-1" role="status">
			<p><strong>Applied.</strong> {applied} It is in the working copy and <code>pitman.json</code>, and goes out with the next save. The old results were cleared.</p>
			<div class="actions">
				<button type="button" class="primary" onclick={onrerun} disabled={busy}>Rerun the network</button>
			</div>
		</div>
	{/if}

	{#if open?.kind === 'view' && entry && viewed}
		<div class="view" data-demand-view={entry.key}>
			<h3 id="demand-view-h" tabindex="-1">{entry.name}</h3>
			<p class="warn">
				This file has no spec in pitman.json, so it isn’t editable as an annual volume, shares and growth: its monthly rows don’t say how they were made, and a spec can’t
				be recovered from them. You can read it here, replace it with a new demand, or remove it.
			</p>
			<dl class="facts provenance">
				<div>
					<dt>Attached to</dt>
					<dd>{entry.attachments.length === 0 ? 'Nothing reads it' : entry.attachments.map(attachmentLabel).join('; ')}</dd>
				</div>
				<div><dt>Years</dt><dd>{hydroYearLabel(entry.firstYear)} to {hydroYearLabel(entry.lastYear)}</dd></div>
				<div><dt>Mean annual</dt><dd>{formatNumber(entry.meanAnnualMm3, 2)} million m³/a</dd></div>
				<div><dt>Source</dt><dd>The file as loaded{viewed.hasTotals ? ', with annual columns' : ''}</dd></div>
			</dl>
			<MonthlyRows rows={viewed.rows} caption={`Rows of ${entry.name}, million m³ a month, October first`} />
			<div class="actions">
				<button type="button" onclick={() => editFile(entry)} disabled={busy}>Replace it with a new demand</button>
				<button type="button" onclick={close}>Close</button>
			</div>
		</div>
	{/if}

	{#if open?.kind === 'edit' && (open.key === null || entry)}
		{#key open.run}
			<DemandEditor {bundle} {...entry ? { file: entry } : {}} start={open.start} {onapply} onclose={close} {busy} />
		{/key}
	{/if}
</section>

<style>
	/* Wide enough to keep a file name whole; on a phone the box scrolls, and the action stays in view at its edge. */
	.files {
		width: 100%;
		min-width: 50rem;
	}
	.files td:last-child {
		position: sticky;
		right: 0;
		background: var(--surface);
	}
	.acts {
		white-space: nowrap;
	}
	.acts button + button {
		margin-left: 0.25rem;
	}
	/* The stuck column takes less of a phone with its two buttons stacked. */
	@media (max-width: 30rem) {
		.acts button {
			display: block;
			width: 100%;
		}
		.acts button + button {
			margin: 0.25rem 0 0;
		}
	}
	.confirm {
		margin: 1rem 0;
	}
	.confirm p,
	.confirm ul {
		margin: 0 0 0.5rem;
	}
	.confirm ul,
	.removals ul {
		padding-left: 1.25rem;
	}
	.confirm fieldset {
		margin: 0 0 0.5rem;
		padding: 0;
		border: 0;
	}
	.confirm legend {
		font-weight: 600;
		padding: 0;
	}
	.choice {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 1.75rem;
	}
	.why {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-bottom: 0.5rem;
		font-weight: 600;
	}
	.removals {
		margin-top: 0.75rem;
		font-size: var(--font-sm);
	}
	.removals p,
	.removals ul {
		margin: 0 0 0.25rem;
	}
	.files tbody th {
		font-weight: 600;
		text-align: left;
		white-space: nowrap;
	}
	.attachment,
	.sub,
	.short {
		display: block;
	}
	.sub {
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.short {
		font-size: var(--font-sm);
		font-weight: 600;
		color: var(--danger);
	}
	.years {
		white-space: nowrap;
	}
	.number {
		text-align: right;
	}
	.view {
		margin-top: 1rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}
	.view h3:focus {
		outline: none;
	}
	.view .actions {
		margin-top: 0.75rem;
	}
</style>
