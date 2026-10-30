<!--
	Calibrate: pick a runoff module, change its parameters, and see the fit at a
	gauge before and after, rerun in historical mode in the worker while you
	type. Edits stay a preview until they are applied; applying hands the page
	an updated bundle (`onupdate`), and the sidecar logs each change. Logic is
	in the .ts files beside this one; the fit table and charts are the results
	screen's own code (comparison.ts). docs/user-guide.md § Calibrate.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { LoadedBundle } from '@pitman/wrsm';
	import { plural } from '#lib/network/format.js';
	import { engineBundle } from '#lib/network/open.js';
	import { runInWorker } from '#lib/network/run-client.js';
	import ChartFigure from '#lib/results/ChartFigure.svelte';
	import { targetCharts } from '#lib/results/charts.js';
	import { hydroYearLabel } from '#lib/results/format.js';
	import { calibrationLog, fileValue, parameterChanges, saveCheck, withCalibration, withChanges, withModule } from './apply.js';
	import { statisticsTable } from '#lib/results/statistics-table.js';
	import { calibrationCandidates, calibrationTargets, gaugeSituation, modelGaps } from './candidates.js';
	import { compactTable, compareRuns, fitSummary } from './comparison.js';
	import { fieldValue, formatValue, groundwaterKind, groundwaterLabel, NO_UNIT, parameterFields, type ParameterField } from './parameters.js';
	import { PreviewRun, previewStatus, type PreviewState, type RunFunction } from './preview.js';
	import { checkDrafts } from './validate.js';

	let {
		bundle,
		onupdate,
		busy = false,
		run = runInWorker
	}: {
		bundle: LoadedBundle;
		/** The working copy changed: the page replaces its bundle, stores it and says `status`. */
		onupdate: (next: LoadedBundle, status: string) => void;
		/** A run is in progress: no apply until it finishes. */
		busy?: boolean;
		/** `runInWorker`, or a fake in tests. */
		run?: RunFunction;
	} = $props();

	const candidates = $derived(calibrationCandidates(bundle));
	const unavailable = $derived(candidates.filter((c) => !c.editable));
	const gaps = $derived(modelGaps(bundle));

	let selected = $state<number | undefined>();
	const module = $derived(selected === undefined ? undefined : bundle.modules.find((m) => m.kind === 'RU' && m.number === selected));
	const runoff = $derived(module?.kind === 'RU' ? module : undefined);
	const fields = $derived(runoff ? parameterFields(runoff) : []);
	const pitmanSet = $derived(fields.filter((f) => f.path.includes('pitman.')));
	const samiSet = $derived(fields.filter((f) => !f.path.includes('pitman.')));

	let drafts = $state<Record<string, string>>({});
	const check = $derived(runoff ? checkDrafts(runoff, fields, drafts) : { values: {}, messages: {}, valid: true });
	const changes = $derived(runoff ? parameterChanges(runoff, fields, check.values) : []);
	const changeList = $derived(changes.map((c) => `${c.field.symbol} ${formatValue(c.field, c.from)} → ${formatValue(c.field, c.to)}`).join(', '));
	const saved = $derived(runoff && changes.length > 0 && check.valid ? saveCheck(withChanges(runoff, changes), fields) : { rounded: [], problem: null });
	const canApply = $derived(changes.length > 0 && check.valid && saved.problem === null && !busy);

	let reason = $state('');
	let applied = $state<string | undefined>();

	let beforeState = $state.raw<PreviewState>({ phase: 'idle' });
	let afterState = $state.raw<PreviewState>({ phase: 'idle' });
	const before = new PreviewRun((b, m, o) => run(b, m, o), (s) => (beforeState = s));
	const after = new PreviewRun((b, m, o) => run(b, m, o), (s) => (afterState = s));

	// The baseline: the network as the working copy has it, whichever module is open.
	const started = $derived(selected !== undefined);
	$effect(() => {
		const current = bundle;
		if (started) untrack(() => before.now(engineBundle(current)));
		else untrack(() => before.clear());
	});

	// The preview follows the values, not the keystrokes: `3` and `3.0` are one run.
	const signature = $derived(JSON.stringify(changes.map((c) => [c.field.path, c.to])));
	$effect(() => {
		void signature;
		const current = bundle;
		const valid = check.valid;
		untrack(() => {
			if (!runoff || changes.length === 0) after.clear();
			else if (!valid) after.cancel();
			else after.schedule(engineBundle(withModule(current, withChanges(runoff, changes))));
		});
	});

	$effect(() => () => {
		before.cancel();
		after.cancel();
	});

	// A different network was loaded: nothing here applies to it.
	let loadedFrom = untrack(() => bundle.files);
	$effect(() => {
		if (bundle.files === loadedFrom) return;
		loadedFrom = bundle.files;
		selected = undefined;
		drafts = {};
		applied = undefined;
	});

	const status = $derived(previewStatus({ before: beforeState, after: afterState, edits: changes.length, valid: check.valid }));
	const running = $derived(beforeState.phase === 'running' || afterState.phase === 'running' || afterState.phase === 'waiting');
	const canRetry = $derived(beforeState.phase === 'cancelled' || beforeState.phase === 'failed' || afterState.phase === 'cancelled' || afterState.phase === 'failed');

	const baseline = $derived(beforeState.result);
	const previewed = $derived(changes.length > 0 ? afterState.result : undefined);
	const targets = $derived(baseline && selected !== undefined ? calibrationTargets(bundle, selected, [baseline]) : []);
	let targetId = $state<string | null>(null);
	const target = $derived(targets.find((t) => t.id === targetId) ?? targets[0] ?? null);
	const gauge = $derived(selected === undefined ? 'noGauges' : gaugeSituation(bundle, selected));

	let period = $state<{ id: string; startYear?: number; endYear?: number }>({ id: '' });
	let includeIncomplete = $state(true);
	const analysis = $derived(
		target && baseline
			? compareRuns(target, baseline, previewed, { ...(period.id === target.id ? { startYear: period.startYear, endYear: period.endYear } : {}), includeIncomplete })
			: null
	);
	const summary = $derived(analysis ? fitSummary(analysis) : null);
	const stats = $derived.by(() => {
		const table = analysis ? statisticsTable(analysis) : null;
		return table && analysis ? compactTable(table, analysis.runs.map((r) => r.label)) : null;
	});
	const charts = $derived(analysis ? targetCharts(analysis) : []);
	const record = $derived(analysis?.timeline ?? null);

	function choose(value: string) {
		selected = value === '' ? undefined : Number(value);
		drafts = {};
		reason = '';
		applied = undefined;
		targetId = null;
		period = { id: '' };
	}

	function edit(field: ParameterField, text: string) {
		drafts = { ...drafts, [field.path]: text };
		applied = undefined;
	}

	function resetField(field: ParameterField) {
		if (!runoff) return;
		edit(field, formatValue(field, fileValue(bundle.sidecar, runoff, field.path)));
	}

	function resetAll() {
		const current = runoff;
		if (!current) return;
		drafts = Object.fromEntries(fields.map((f) => [f.path, formatValue(f, fileValue(bundle.sidecar, current, f.path))]));
		applied = undefined;
	}

	function setYear(which: 'startYear' | 'endYear', value: string) {
		if (!target) return;
		const year = Number(value);
		const current = period.id === target.id ? period : { id: target.id };
		period = { ...current, id: target.id, [which]: value === '' || !Number.isInteger(year) ? undefined : year };
	}

	function retry() {
		if (beforeState.phase === 'cancelled' || beforeState.phase === 'failed') before.now(engineBundle(bundle));
		if ((afterState.phase === 'cancelled' || afterState.phase === 'failed') && runoff && check.valid && changes.length > 0) {
			after.now(engineBundle(withModule(bundle, withChanges(runoff, changes))));
		}
	}

	async function apply() {
		if (!runoff || !canApply) return;
		const text = `Applied ${plural(changes.length, 'change')} to RU ${runoff.number}: ${changeList}.`;
		const next = withCalibration(bundle, runoff, changes, { reason });
		drafts = {};
		reason = '';
		applied = text;
		onupdate(next, text);
		await tick();
		document.getElementById('calibrate-applied')?.focus();
	}
</script>

{#snippet parameterRows(title: string, source: string, list: readonly ParameterField[])}
	<fieldset class="set">
		<legend>{title}</legend>
		<p class="note">From {source}. Each row gives the value in the network file and its place there.</p>
		{#each list as field (field.path)}
			{@const id = `calibrate-${field.path.replaceAll('.', '-')}`}
			{@const current = runoff ? fieldValue(runoff, field.path) : NaN}
			{@const file = runoff ? fileValue(bundle.sidecar, runoff, field.path) : NaN}
			{@const log = selected === undefined ? [] : calibrationLog(bundle.sidecar, selected, field.path)}
			{@const latest = log.at(-1)}
			{@const message = check.messages[field.path]}
			{@const value = drafts[field.path] ?? formatValue(field, current)}
			<div class="row" data-field={field.path} class:edited={check.values[field.path] !== current}>
				<div class="what">
					<label for={id}><span class="symbol">{field.symbol}</span> {field.name}</label>
				</div>
				<div class="value">
					<input
						{id}
						type="text"
						inputmode={field.rule === 'any' ? 'text' : 'decimal'}
						autocomplete="off"
						spellcheck="false"
						{value}
						aria-invalid={message?.level === 'error' ? 'true' : undefined}
						aria-describedby={`${id}-unit ${id}-origin${message ? ` ${id}-msg` : ''}`}
						oninput={(e) => edit(field, e.currentTarget.value)}
					/>
					<span class="unit" id={`${id}-unit`}>{field.unit === NO_UNIT ? 'no unit' : field.unit}</span>
				</div>
				<div class="origin">
					<p id={`${id}-origin`}>
						In the file <strong class="number">{formatValue(field, file)}</strong> <span class="place">({field.line})</span>
						{#if current !== file && latest}
							<span class="place">Applied {formatValue(field, current)} on {latest.date.slice(0, 10)}{latest.reason ? `: ${latest.reason}` : ''}</span>
						{/if}
					</p>
					<button type="button" class="reset" onclick={() => resetField(field)} disabled={value === formatValue(field, file)}>
						Reset<span class="sr"> {field.symbol} to {formatValue(field, file)}</span>
					</button>
				</div>
				{#if field.caution}
					<p class="caution">{field.caution}</p>
				{/if}
				{#if message}
					<p id={`${id}-msg`} class="msg" class:error={message.level === 'error'} class:warn={message.level === 'warning'}>{message.text}</p>
				{/if}
			</div>
		{/each}
	</fieldset>
{/snippet}

<section aria-labelledby="calibrate-h" class="card">
	<h2 id="calibrate-h">Calibrate</h2>
	<p>
		Change a runoff module’s parameters and see the simulated flow and the fit to a gauge move. The network reruns in historical mode as you type. Nothing
		changes in the working copy until you apply it.
	</p>

	{#if candidates.length === 0}
		<p class="note">This network has no runoff modules to calibrate.</p>
	{:else}
		<div class="pick">
			<label for="calibrate-module">Runoff module</label>
			<select id="calibrate-module" value={selected ?? ''} onchange={(e) => choose(e.currentTarget.value)}>
				<option value="">Choose a module</option>
				{#each candidates as c (c.number)}
					<option value={c.number} disabled={!c.editable}>{c.label}{c.why ? ` (${c.why})` : ''}</option>
				{/each}
			</select>
		</div>
		{#if unavailable.length > 0}
			<details class="unavailable">
				<summary>{plural(unavailable.length, 'module')} can’t be edited here</summary>
				<ul>
					{#each unavailable as c (c.number)}
						<li>{c.label}: {c.why}.</li>
					{/each}
				</ul>
			</details>
		{/if}
	{/if}

	{#if applied}
		<div class="applied" id="calibrate-applied" tabindex="-1" role="status">
			<p><strong>Applied to the working copy.</strong> {applied}</p>
			<p>It’s recorded in <code>pitman.json</code> with the value it replaced, and goes out with the next save. The old results were cleared: <a href="#run-h">run the network</a> to see them with these values.</p>
		</div>
	{/if}

	{#if runoff}
		{@const parent = runoff.sfrChildren && runoff.sfrChildren.length > 0}
		{@const file = bundle.files.modules[`RU${runoff.number}`] ?? `RU ${runoff.number}`}
		{@const kind = groundwaterKind(runoff)}
		<dl class="facts provenance module">
			<div><dt>Catchment</dt><dd>{runoff.areaKm2} km², MAP {runoff.mapMm} mm</dd></div>
			<div><dt>Rainfall file</dt><dd>{runoff.rainfallFile.trim()}</dd></div>
			<div><dt>Groundwater model</dt><dd>{groundwaterLabel(kind)}</dd></div>
			<div><dt>Parameters read from</dt><dd>{file}, {kind === 'sami' ? 'L.031–L.035' : 'L.003'}</dd></div>
		</dl>
		{#if parent}
			<p class="note">This is an SFR parent: its {plural(runoff.sfrChildren?.length ?? 0, 'child', 'children')} take these parameters and are calibrated again to their reduction targets in every run, so a change here reaches them too.</p>
		{/if}
		{#each gaps as gap (gap)}
			<p class="warn">{gap}</p>
		{/each}

		<div class="work">
			<div class="parameters">
				{@render parameterRows(kind === 'sami' ? 'Pitman parameters of the Sami set' : 'Pitman parameters', `${file}, ${kind === 'sami' ? 'L.035' : 'L.003'}`, pitmanSet)}
				{#if samiSet.length > 0}
					{@render parameterRows('Sami groundwater parameters', `${file}, L.031–L.034`, samiSet)}
				{/if}
				<div class="actions">
					<button type="button" onclick={resetAll}>Reset all to the file</button>
				</div>
			</div>

			<div class="live">
				<div class="state" data-preview={beforeState.phase === 'running' || running ? 'running' : 'settled'}>
					<p role="status" aria-live="polite" class:error={beforeState.phase === 'failed' || afterState.phase === 'failed'}>{status}</p>
					{#if running}
						<button
							type="button"
							onclick={() => {
								before.cancel();
								after.cancel();
							}}>Cancel</button
						>
					{:else if canRetry}
						<button type="button" onclick={retry}>Run again</button>
					{/if}
				</div>

				{#if changes.length > 0}
					<div class="pending">
						<p class="list"><strong>Preview only:</strong> {changeList}</p>
						<p class="note">Results and a save keep the earlier values until you apply.</p>
						{#if saved.rounded.length > 0}
							<p class="warn">Saving rewrites this module’s file, which rounds {saved.rounded.join(', ')}: the loaded file held more decimals than WRSM2000’s format keeps.</p>
						{/if}
						{#if saved.problem}
							<p class="error">The module can’t be written: {saved.problem}</p>
						{/if}
						<div class="commit">
							<div class="why">
								<label for="calibrate-reason">Reason (optional, saved with the change)</label>
								<input id="calibrate-reason" type="text" autocomplete="off" bind:value={reason} />
							</div>
							<button type="button" class="primary" onclick={apply} disabled={!canApply}>Apply to the working copy</button>
						</div>
						{#if busy}
							<p class="note">Wait for the run to finish.</p>
						{/if}
					</div>
				{/if}

				{#if gauge === 'noGauges'}
					<p class="note">This network has no gauges, so there is no observed flow to fit. You can still compare your edits with the file’s values at any route below the module.</p>
				{:else if gauge === 'noneDownstream'}
					<p class="note">No gauge lies below this module, so there is no observed flow to fit. You can still compare your edits with the file’s values at any route below it.</p>
				{/if}

				{#if targets.length > 0 && target}
					<div class="pick">
						<label for="calibrate-target">Compare at</label>
						<select id="calibrate-target" value={target.id} onchange={(e) => (targetId = e.currentTarget.value)}>
							{#each targets as t (t.id)}
								<option value={t.id}>{t.label}</option>
							{/each}
						</select>
						{#if target.gauge !== null && target.observed === null}
							<p class="note">The gauge’s observed-flow file ({target.gauge.observedFile.trim()}) is not in the network folder.</p>
						{/if}
					</div>
				{:else if baseline}
					<p class="note">No route leaves this module, so there is no flow to compare.</p>
				{/if}

				{#if summary}
					<dl class="facts results">
						<div>
							<dt>MAR at this route</dt>
							<dd>{summary.mar}{summary.marChange ? ` (${summary.marChange})` : ''}</dd>
						</div>
						{#if summary.withinGuidelines}
							<div>
								<dt>Statistics within the TT 689 guidelines</dt>
								<dd>{summary.withinGuidelines.join(' → ')}</dd>
							</div>
						{/if}
					</dl>
				{/if}

				{#if stats}
					<div class="scroll">
						<table class="data fit">
							<caption>{stats.caption}</caption>
							<thead>
								<tr>
									<th scope="col">Statistic</th>
									{#each stats.columns as column (column)}
										<th scope="col">{column}</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each stats.rows as row (row.key)}
									<tr data-statistic={row.key}>
										<th scope="row">{row.label}<span class="sub">{row.unit}</span></th>
										{#if row.observed !== undefined}
											<td>{row.observed}</td>
										{/if}
										{#each row.runs as cell, i (i)}
											<td>
												{cell.value}
												{#if cell.error}
													<span class="sub" class:outside={cell.outside}>{cell.error}</span>
												{/if}
											</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#each stats.notes as note (note)}
						<p class="note">{note}</p>
					{/each}
				{/if}

				{#if record && target}
					<fieldset class="period">
						<legend>Statistics period (hydrological years)</legend>
						<label>
							From
							<input type="number" inputmode="numeric" min={record.startYear} max={record.startYear + record.years - 1} value={analysis?.period?.startYear ?? ''} onchange={(e) => setYear('startYear', e.currentTarget.value)} />
						</label>
						<label>
							to
							<input type="number" inputmode="numeric" min={record.startYear} max={record.startYear + record.years - 1} value={analysis?.period?.endYear ?? ''} onchange={(e) => setYear('endYear', e.currentTarget.value)} />
						</label>
						<button type="button" onclick={() => (period = { id: '' })}>{target.observed !== null ? 'Gauge record' : 'Whole record'}</button>
						{#if target.observed !== null}
							<label class="check">
								<input type="checkbox" bind:checked={includeIncomplete} />
								Use incomplete observed months (+)
							</label>
						{/if}
						{#if analysis?.period}
							<p class="note">{hydroYearLabel(analysis.period.startYear)} to {hydroYearLabel(analysis.period.endYear)}.</p>
						{/if}
					</fieldset>
				{/if}
			</div>
		</div>

		{#if charts.length > 0 && target}
			<div class="charts" aria-label="Charts at the chosen route" role="group">
				{#each charts as spec (spec.id)}
					<ChartFigure {spec} idPrefix="calibrate-{target.id}" />
				{/each}
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
	.why label {
		font-weight: 650;
	}
	.pick select {
		width: 100%;
	}
	.unavailable ul {
		margin: 0.25rem 0;
		padding-left: 1.25rem;
		font-size: var(--font-sm);
	}
	.applied {
		border-left: 4px solid var(--accent);
		background: var(--accent-soft);
		border-radius: var(--radius);
		padding: 0.25rem 1rem;
		margin: 1rem 0;
	}
	.work {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem 1.5rem;
		margin-top: 1rem;
	}
	/* The fit stays in view beside the parameters, however long the Sami set runs. */
	@media (min-width: 75rem) {
		.work {
			grid-template-columns: minmax(0, 28rem) minmax(0, 1fr);
			align-items: start;
		}
		.live {
			position: sticky;
			top: calc(var(--bar-h) + 0.75rem);
			max-height: calc(100vh - var(--bar-h) - 1.5rem);
			overflow-y: auto;
		}
	}
	.live {
		min-width: 0;
	}
	.set {
		margin-bottom: 1rem;
		padding: 0.5rem 0.75rem 0.25rem;
	}
	.set .note {
		margin: 0 0 0.25rem;
		font-size: var(--font-sm);
	}
	/* The label, then value and origin on a line, wrapping apart on a phone; a message or caution takes the full width. */
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.15rem 0.75rem;
		padding: 0.4rem 0;
		border-top: 1px solid var(--border);
	}
	.row.edited {
		box-shadow: inset 3px 0 0 var(--accent);
		padding-left: 0.5rem;
	}
	.what {
		flex-basis: 100%;
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.symbol {
		font-size: 0.9rem;
		font-weight: 650;
		color: var(--text);
	}
	.value {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}
	.value input {
		width: 6.5rem;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.unit {
		font-size: var(--font-sm);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.origin {
		display: flex;
		margin-left: auto;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		font-size: var(--font-sm);
		min-width: 0;
	}
	.origin p {
		margin: 0;
		text-align: right;
	}
	.number {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.place {
		display: block;
		color: var(--text-muted);
		font-size: var(--font-xs);
	}
	.reset {
		padding: 0 0.6rem;
	}
	.caution,
	.msg {
		flex-basis: 100%;
		margin: 0.15rem 0 0;
		font-size: var(--font-sm);
	}
	.caution {
		color: var(--text-muted);
	}
	.msg.error {
		font-weight: 600;
	}
	.state {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		min-height: var(--control-h);
	}
	.state p {
		margin: 0;
	}
	.pending {
		border-left: 4px solid var(--warning);
		background: var(--warning-soft);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem 0.75rem;
		margin: 0.5rem 0;
	}
	.pending p {
		margin: 0 0 0.35rem;
	}
	.pending .list {
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}
	.pending .note {
		font-size: var(--font-sm);
	}
	.commit {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 0.75rem;
	}
	.why {
		display: flex;
		flex: 1 1 14rem;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
		font-size: var(--font-sm);
	}
	.why input {
		width: 100%;
	}
	.fit {
		width: 100%;
	}
	.fit td,
	.fit tbody th {
		line-height: 1.3;
	}
	.fit .sub {
		display: block;
		font-size: var(--font-xs);
		color: var(--text-muted);
	}
	/* Value and error stack, and the error may break, so both runs stay in view beside the parameters. */
	table.fit th,
	table.fit td {
		white-space: normal;
		padding-inline: 0.4rem;
	}
	table.fit td {
		min-width: 5.5rem;
	}
	/* The statistic's name stays beside its numbers when a narrow box scrolls. */
	.fit tbody th,
	.fit thead th:first-child {
		position: sticky;
		left: 0;
		background: var(--surface);
	}
	.fit thead th:first-child {
		background: var(--surface-2);
	}
	/* The word "outside" carries the meaning; weight and colour only repeat it. */
	.fit .sub.outside {
		color: var(--danger);
		font-weight: 600;
	}
	.period {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		margin-top: 0.75rem;
		font-size: var(--font-sm);
	}
	.period input[type='number'] {
		width: 5.5rem;
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
	.charts {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		margin-top: 1rem;
	}
	@media (min-width: 72rem) {
		.charts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
