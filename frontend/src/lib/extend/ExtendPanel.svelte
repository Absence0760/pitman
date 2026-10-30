<!--
	"Extend rainfall with CHIRPS" (method A, docs/theory/extend.md): the
	network's .RAN files with the modules that read each, and the extension
	of the one chosen (ExtendFile.svelte). Applying hands the page an updated
	bundle (`onupdate`); the page stores it as the working copy. After an
	apply the panel offers to move the run's last year and to rerun.
-->
<script lang="ts">
	import { scrollable } from '#lib/shell/scrollable.js';
	import { tick } from 'svelte';
	import type { ChirpsMonthly, ExtensionResult, LoadedBundle } from '@pitman/wrsm';
	import { hydroYearLabel } from '#lib/results/format.js';
	import { fetchChirpsMonthly } from './api.js';
	import { API_BASE_URL } from './api-base.js';
	import type { ParsedArea } from './area.js';
	import { runPeriodOffer, withEndYear, withExtension } from './apply.js';
	import { extensionEngine, type ExtensionEngine } from './engine.js';
	import ExtendFile from './ExtendFile.svelte';
	import { rainfallFiles, usersLabel } from './files.js';
	import { extensionLabel, previousExtension } from './provenance.js';

	let {
		bundle,
		onupdate,
		onrerun,
		busy = false,
		engine = extensionEngine,
		fetchChirps = (area: ParsedArea['geometry'], signal: AbortSignal): Promise<ChirpsMonthly> =>
			fetchChirpsMonthly(area, { baseUrl: API_BASE_URL, signal })
	}: {
		bundle: LoadedBundle;
		/** The working copy changed: the page replaces its bundle, stores it and says `status`. */
		onupdate: (next: LoadedBundle, status: string) => void;
		/** Run the network again (the page's Run, with the modes chosen there). */
		onrerun: () => void;
		/** A run is in progress: no apply until it finishes. */
		busy?: boolean;
		engine?: ExtensionEngine;
		fetchChirps?: (area: ParsedArea['geometry'], signal: AbortSignal) => Promise<ChirpsMonthly>;
	} = $props();

	const files = $derived(rainfallFiles(bundle));
	let selected = $state<string | undefined>();
	const entry = $derived(files.find((f) => f.key === selected));
	const series = $derived(entry ? bundle.rainfall[entry.key] : undefined);
	let applied = $state<string | undefined>();
	const offer = $derived(runPeriodOffer(bundle));

	async function choose(key: string) {
		selected = key;
		applied = undefined;
		await tick();
		document.getElementById(`extend-${key.replace(/[^A-Za-z0-9]+/g, '-')}-h`)?.focus();
	}

	async function close() {
		const key = selected;
		selected = undefined;
		await tick();
		if (key) document.getElementById(`extend-pick-${key.replace(/[^A-Za-z0-9]+/g, '-')}`)?.focus();
	}

	async function onapplied(result: ExtensionResult, summary: string) {
		if (!entry) return;
		const key = entry.key;
		onupdate(withExtension(bundle, key, result), summary);
		applied = summary;
		selected = undefined;
		await tick();
		document.getElementById('extend-applied')?.focus();
	}

	function extendRun() {
		if (!offer.canExtend) return;
		const status = `The run now ends ${hydroYearLabel(offer.reachableEndYear)} (was ${hydroYearLabel(offer.currentEndYear)}).`;
		onupdate(withEndYear(bundle, offer.reachableEndYear), status);
		applied = `${applied ?? ''} ${status}`.trim();
	}
</script>

<section aria-labelledby="extend-h" class="card">
	<h2 id="extend-h">Extend rainfall with CHIRPS</h2>
	<p>
		Bring a rainfall file (<code>.RAN</code>, % of MAP) up to the last complete hydrological year: Pitman averages CHIRPS over the area the file represents,
		fits 12 monthly factors over the years both cover, and appends the corrected CHIRPS years. You see the fit and can change every factor before anything is
		applied (docs: method A).
	</p>

	{#if files.length === 0}
		<p class="note">This network has no rainfall files.</p>
	{:else}
		<div class="scroll" use:scrollable>
			<table class="files" aria-label="Rainfall files">
				<thead>
					<tr><th scope="col">File</th><th scope="col">Years</th><th scope="col">Read by</th><th scope="col">Extension</th><th scope="col"><span class="sr">Action</span></th></tr>
				</thead>
				<tbody>
					{#each files as f (f.key)}
						<tr data-file={f.key}>
							<th scope="row">{f.name}<span class="sub">zone {f.code}</span></th>
							<td>{hydroYearLabel(f.firstYear)} to {hydroYearLabel(f.lastYear)}</td>
							<td>{usersLabel(f.users)}</td>
							<td>{f.extension ? extensionLabel(f.extension) : 'none'}</td>
							<td>
								<button
									type="button"
									id={`extend-pick-${f.key.replace(/[^A-Za-z0-9]+/g, '-')}`}
									onclick={() => choose(f.key)}
									aria-pressed={selected === f.key}
									disabled={busy}
								>
									{f.extension ? 'Extend again' : 'Extend'}<span class="sr"> {f.name}</span>
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if applied}
		<div class="applied" id="extend-applied" tabindex="-1" role="status">
			<p><strong>Applied.</strong> {applied}</p>
			{#if offer.canExtend}
				<p>
					The network runs to {hydroYearLabel(offer.currentEndYear)}, so a rerun would not use the new years yet. Every rainfall file the modules read now
					reaches {hydroYearLabel(offer.reachableEndYear)}.
				</p>
				<div class="actions">
					<button type="button" onclick={extendRun}>Run to {hydroYearLabel(offer.reachableEndYear)}</button>
				</div>
			{:else if offer.reachableEndYear > offer.currentEndYear || offer.limitedBy.length > 0}
				<p class="note">{offer.reason || `Extend ${offer.limitedBy.join(', ')} too before the run can reach further.`}</p>
			{/if}
			<p>Rerun the network to see results with the extended record.</p>
			<div class="actions">
				<button type="button" class="primary" onclick={onrerun} disabled={busy}>Rerun the network</button>
			</div>
		</div>
	{/if}

	{#if entry && series}
		{#key entry.key}
			<ExtendFile {entry} {series} {engine} {fetchChirps} {onapplied} onclose={close} />
		{/key}
	{/if}
</section>

<style>
	/* Wide enough to keep a file name whole; on a phone the box scrolls, and the action stays in view at its edge. */
	.files {
		width: 100%;
		min-width: 38rem;
	}
	.files td:last-child {
		position: sticky;
		right: 0;
		background: var(--surface);
	}
	.files tbody th {
		font-weight: 600;
		white-space: nowrap;
	}
	.sub {
		display: block;
		font-weight: 400;
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
</style>
