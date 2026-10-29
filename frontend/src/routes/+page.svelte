<!--
	The app shell: load → validate → keep a working copy → run (Web Worker)
	→ results → save as a WRSM2000 zip. Logic lives in $lib/network/*.ts
	(tested there); this page holds the state and wires it to the pieces.
	docs/architecture.md § App flow describes it.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import IssueList from '#lib/network/IssueList.svelte';
	import LoadPanel from '#lib/network/LoadPanel.svelte';
	import ModePicker from '#lib/network/ModePicker.svelte';
	import { downloadBytes } from '#lib/network/download.js';
	import { writeBundle, type BundleFiles, type BundleIssue, type LoadedBundle } from '#lib/network/engine.js';
	import { formatDateTime, plural } from '#lib/network/format.js';
	import { LoadError } from '#lib/network/limits.js';
	import { DEFAULT_MODE_CHOICE, modeId, modeLabel, modesFromChoice, type ModeChoice } from '#lib/network/modes.js';
	import { engineBundle, openNetwork, summarise } from '#lib/network/open.js';
	import { runInWorker, type RunOutcome, type RunProgress } from '#lib/network/run-client.js';
	import { saveFileName, saveZip } from '#lib/network/save.js';
	import { readSources, sourceName, type SourceFile } from '#lib/network/sources.js';
	import { browserIndexedDB, forgetWorkingCopy, loadWorkingCopy, storeWorkingCopy } from '#lib/network/storage.js';
	import Results from '#lib/results/Results.svelte';

	type Phase = 'empty' | 'reading' | 'choose' | 'invalid' | 'loaded';
	type RunState = 'idle' | 'running' | 'done' | 'failed';

	let phase = $state<Phase>('empty');
	// Raw (not deep-proxied): these are large and are posted to the worker and IndexedDB.
	let files = $state.raw<BundleFiles | undefined>();
	let name = $state('network');
	let networks = $state.raw<readonly string[]>([]);
	let chosen = $state('');
	let bundle = $state.raw<LoadedBundle | undefined>();
	let errors = $state.raw<readonly BundleIssue[]>([]);
	let warnings = $state.raw<readonly BundleIssue[]>([]);
	let restoredAt = $state<string | undefined>();
	let storageNote = $state<string | undefined>();
	let status = $state('');

	let choice = $state<ModeChoice>({ ...DEFAULT_MODE_CHOICE });
	let modeError = $state<{ text: string; field: 'year' | 'modes' } | undefined>();
	let runState = $state<RunState>('idle');
	let progress = $state<RunProgress | undefined>();
	let outcomes = $state.raw<readonly RunOutcome[]>([]);
	let runError = $state<string | undefined>();
	let saveError = $state<string | undefined>();
	let controller: AbortController | undefined;

	const summary = $derived(bundle ? summarise(bundle) : undefined);
	const runs = $derived(outcomes.flatMap((o) => (o.ok ? [o.result] : [])));
	const failedModes = $derived(outcomes.filter((o) => !o.ok));

	function reset() {
		phase = 'empty';
		files = undefined;
		bundle = undefined;
		networks = [];
		errors = [];
		warnings = [];
		restoredAt = undefined;
		storageNote = undefined;
		outcomes = [];
		runState = 'idle';
		runError = undefined;
		saveError = undefined;
		modeError = undefined;
	}

	async function loadSources(sources: SourceFile[]) {
		controller?.abort();
		reset();
		phase = 'reading';
		status = 'Reading the files…';
		try {
			files = await readSources(sources);
		} catch (error) {
			phase = 'invalid';
			errors = [{ level: 'error', file: sources.length === 1 ? (sources[0]?.path ?? '(files)') : '(files)', message: (error as Error).message }];
			status = 'The files could not be read.';
			if (!(error instanceof LoadError)) console.error(error);
			return;
		}
		name = sourceName(sources);
		open();
	}

	/** Validate the loaded files as a network (and keep it as the working copy when `persist`); returns whether it loaded. */
	function open(network?: string, persist = true): boolean {
		if (!files) return false;
		const outcome = openNetwork(files, network);
		if (outcome.kind === 'choose') {
			phase = 'choose';
			networks = outcome.networks;
			chosen = outcome.networks[0] ?? '';
			status = `The folder holds ${outcome.networks.length} networks: choose one.`;
		} else if (outcome.kind === 'invalid') {
			phase = 'invalid';
			errors = outcome.errors;
			warnings = outcome.warnings;
			status = `The network has ${plural(outcome.errors.length, 'problem')}.`;
		} else {
			phase = 'loaded';
			bundle = outcome.bundle;
			warnings = outcome.warnings;
			errors = [];
			status = `Loaded network ${outcome.bundle.network.code}.`;
			if (persist) void keepWorkingCopy();
			return true;
		}
		return false;
	}

	async function keepWorkingCopy() {
		const factory = browserIndexedDB();
		if (!bundle || !factory) {
			storageNote = 'This browser does not allow a working copy, so a reload will start empty. Save the zip to keep your work.';
			return;
		}
		try {
			await storeWorkingCopy(
				{ schema: 1, name, network: bundle.files.network, files: writeBundle(bundle), storedAt: new Date().toISOString(), modes: $state.snapshot(choice) },
				factory
			);
			storageNote = undefined;
		} catch {
			storageNote = 'The working copy could not be stored (the browser may be out of space or in private mode). Save the zip to keep your work.';
		}
	}

	async function forget() {
		controller?.abort();
		const factory = browserIndexedDB();
		try {
			if (factory) await forgetWorkingCopy(factory);
			reset();
			status = 'The working copy was forgotten. Nothing of the network is left in this browser.';
		} catch {
			status = 'The working copy could not be deleted. Clear this site’s data in the browser settings to remove it.';
		}
	}

	async function startRun() {
		if (!bundle) return;
		const picked = modesFromChoice(choice);
		if (!picked.ok) {
			modeError = { text: picked.error, field: picked.field };
			document.getElementById(picked.field === 'year' ? 'mode-year' : 'mode-present')?.focus();
			return;
		}
		modeError = undefined;
		runError = undefined;
		outcomes = [];
		runState = 'running';
		progress = undefined;
		status = `Running ${plural(picked.modes.length, 'mode')}…`;
		void keepWorkingCopy();
		controller = new AbortController();
		try {
			outcomes = await runInWorker(engineBundle(bundle), picked.modes, {
				signal: controller.signal,
				onProgress: (p) => {
					progress = p;
					status = `Running ${modeLabel(p.mode)} (${p.index + 1} of ${p.total})…`;
				}
			});
			runState = 'done';
			const failed = outcomes.filter((o) => !o.ok).length;
			status = failed === 0 ? 'The run finished.' : `The run finished; ${plural(failed, 'mode')} failed.`;
		} catch (error) {
			if ((error as Error).name === 'AbortError') {
				runState = 'idle';
				status = 'The run was cancelled.';
			} else {
				runState = 'failed';
				runError = (error as Error).message;
				status = 'The run stopped.';
			}
		} finally {
			controller = undefined;
			progress = undefined;
		}
	}

	function save() {
		if (!bundle) return;
		saveError = undefined;
		try {
			const fileName = saveFileName(bundle, name);
			downloadBytes(fileName, saveZip(bundle, { writtenBy: `Pitman ${__PITMAN_VERSION__}` }));
			status = `Saved ${fileName}.`;
		} catch (error) {
			saveError = (error as Error).message;
		}
	}

	onMount(() => {
		const factory = browserIndexedDB();
		if (!factory) return;
		loadWorkingCopy(factory)
			.then((copy) => {
				if (!copy || phase !== 'empty') return;
				files = copy.files;
				name = copy.name;
				if (copy.modes) choice = { ...copy.modes };
				if (open(copy.network, false)) {
					restoredAt = copy.storedAt;
					status = `Restored the working copy of network ${bundle?.network.code ?? ''}.`;
				}
			})
			.catch(() => {
				storageNote = 'The working copy could not be read.';
			});
		return () => controller?.abort();
	});
</script>

<svelte:head>
	<title>Pitman: the WRSM2000/Pitman model in your browser</title>
	<meta
		name="description"
		content="Load a WRSM2000 network, run it in present-day, natural and historical modes, and save it back as WRSM2000 files. Your files stay in your browser."
	/>
</svelte:head>

<main class="page">
	<header>
		<h1>Pitman</h1>
		<p class="lede">
			A rebuild of the WRSM2000 / Pitman monthly rainfall-runoff model, written from the Water Research Commission's published manuals (TT 687, 689, 690
			and 691). Load a WRSM2000 network, run it, and save it back as files WRSM2000 opens.
		</p>
		<ul class="promises">
			<li><strong>Your files stay in your browser.</strong> Nothing is uploaded: the network is read, run and saved on this computer.</li>
			<li>
				The browser keeps a <strong>working copy</strong> so a reload picks up where you were. Your own copy is the zip you save; you can forget the working
				copy at any time.
			</li>
		</ul>
	</header>

	<section aria-labelledby="load-h">
		<h2 id="load-h">Load a network</h2>
		<p>
			Choose the WRSM2000 network folder, or a zip of it: the <code>.NET</code> file, the module <code>.DAT</code> files, and the rainfall, observed and defined-flow
			files they name. Anything else in the folder (outputs, diagrams) is kept and saved back unchanged.
		</p>
		<LoadPanel onload={loadSources} busy={phase === 'reading' || runState === 'running'} />
	</section>

	<p class="status" role="status" aria-live="polite">{status}</p>

	{#if phase === 'choose'}
		<section aria-labelledby="choose-h">
			<h2 id="choose-h">Choose a network</h2>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					open(chosen);
				}}
			>
				<fieldset>
					<legend>This folder holds {networks.length} networks</legend>
					{#each networks as path (path)}
						<div class="radio">
							<input type="radio" id={`net-${path}`} name="network" value={path} bind:group={chosen} />
							<label for={`net-${path}`}>{path}</label>
						</div>
					{/each}
				</fieldset>
				<button type="submit" class="primary">Open this network</button>
			</form>
		</section>
	{/if}

	{#if errors.length > 0}
		{#key errors}
			<IssueList issues={errors} id="errors-h" title={`The network can’t be loaded: ${plural(errors.length, 'problem')}`} focus />
		{/key}
	{/if}

	{#if bundle && summary}
		<section aria-labelledby="network-h">
			<h2 id="network-h">Network {summary.code}</h2>
			<dl class="facts">
				<div><dt>Loaded from</dt><dd>{name}</dd></div>
				<div><dt>Years</dt><dd>{summary.startYear}/{String(summary.startYear + 1).slice(2)} to {summary.endYear}/{String(summary.endYear + 1).slice(2)} (hydrological years)</dd></div>
				<div><dt>Modules</dt><dd>{summary.modules.map((m) => `${m.count} ${m.label}`).join(', ')}</dd></div>
				<div><dt>Routes</dt><dd>{summary.routes}</dd></div>
				<div><dt>Gauges</dt><dd>{summary.gauges}</dd></div>
				<div><dt>Files read</dt><dd>{plural(summary.rainfallFiles, 'rainfall file')}, {plural(summary.flowFiles, 'defined-flow file')}</dd></div>
				<div><dt>Provenance (pitman.json)</dt><dd>{summary.hasSidecar ? 'present' : 'none yet; written when you save'}</dd></div>
			</dl>
			{#if summary.notModelled.length > 0}
				<p class="note">Kept but not modelled: {summary.notModelled.join('; ')}.</p>
			{/if}
			{#if restoredAt}
				<p class="note">Restored from this browser’s working copy, stored {formatDateTime(restoredAt)}.</p>
			{/if}
			{#if storageNote}
				<p class="note warn">{storageNote}</p>
			{/if}
			<div class="actions">
				<button type="button" class="primary" onclick={save}>Save as WRSM2000 zip</button>
				<button type="button" onclick={forget}>Forget the working copy</button>
			</div>
			{#if saveError}
				<p class="error" role="alert">The zip could not be saved: {saveError}</p>
			{/if}
		</section>

		{#if warnings.length > 0}
			<IssueList issues={warnings} id="warnings-h" title={`Check ${plural(warnings.length, 'warning')}`} />
		{/if}

		<section aria-labelledby="run-h">
			<h2 id="run-h">Run</h2>
			<ModePicker bind:choice error={modeError?.text} errorField={modeError?.field} disabled={runState === 'running'} />
			<div class="actions">
				<button type="button" class="primary" onclick={startRun} disabled={runState === 'running'}>Run</button>
				{#if runState === 'running'}
					<button type="button" onclick={() => controller?.abort()}>Cancel</button>
				{/if}
			</div>
			{#if runState === 'running'}
				<div class="progress">
					<label for="run-progress">{progress ? `${modeLabel(progress.mode)}, ${progress.index + 1} of ${progress.total}` : 'Starting the run'}</label>
					<progress id="run-progress" max={progress?.total ?? 1} value={progress?.index ?? 0}></progress>
				</div>
			{/if}
			{#if runError}
				<p class="error" role="alert">The run stopped: {runError}</p>
			{/if}
		</section>

		<!-- Results.svelte is its own region headed "Results"; this wrapper only carries the run state and,
		     before there are results, the same heading, so the page never has two regions of one name. -->
		<div class="run-output" data-run-state={runState} data-ready={runState === 'done' ? 'true' : 'false'}>
			{#if runs.length === 0}
				<h2>Results</h2>
			{/if}
			{#if failedModes.length > 0}
				<ul class="failures" aria-label="Modes that failed">
					{#each failedModes as failure (modeId(failure.mode))}
						<li><strong>{modeLabel(failure.mode)}</strong> failed: {failure.ok ? '' : failure.message}</li>
					{/each}
				</ul>
			{/if}
			{#if runs.length > 0}
				<Results {bundle} {runs} />
			{:else if runState !== 'done'}
				<p class="note">Choose the modes and run the network to see results here.</p>
			{/if}
		</div>
	{/if}
</main>

<style>
	.page {
		max-width: 75ch;
		margin: 0 auto;
		padding: 1.5rem 1rem 4rem;
	}
	h1 {
		font-size: 2rem;
		margin: 0 0 0.5rem;
	}
	h2 {
		font-size: 1.35rem;
		margin: 2rem 0 0.75rem;
	}
	.lede {
		font-size: 1.1rem;
	}
	.promises {
		padding-left: 1.25rem;
	}
	.promises li {
		margin: 0.35rem 0;
	}
	.status {
		min-height: 1.5em;
		color: var(--text-muted);
		margin: 1rem 0 0;
	}
	.facts {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.4rem;
		margin: 0;
	}
	.facts div {
		display: grid;
		grid-template-columns: minmax(8rem, 14rem) minmax(0, 1fr);
		gap: 0.75rem;
	}
	.facts dt {
		color: var(--text-muted);
	}
	.facts dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	@media (max-width: 30rem) {
		.facts div {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 1rem;
	}
	button {
		font: inherit;
		min-height: 2.75rem;
		padding: 0 1rem;
		border-radius: 0.375rem;
		border: 1px solid var(--border-strong);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	button.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}
	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	fieldset {
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		margin: 0 0 1rem;
	}
	.radio {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		min-height: 2.25rem;
		overflow-wrap: anywhere;
	}
	.progress {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 1rem;
	}
	progress {
		width: 100%;
		height: 0.75rem;
	}
	.note {
		color: var(--text-muted);
	}
	.note.warn {
		color: var(--text);
		border-left: 4px solid var(--warning);
		padding-left: 0.75rem;
	}
	.error {
		color: var(--danger);
		font-weight: 600;
	}
	.failures {
		padding-left: 1.25rem;
		color: var(--danger);
	}
	code {
		font-family: ui-monospace, monospace;
		font-size: 0.95em;
	}
</style>
