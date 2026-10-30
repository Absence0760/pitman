<!--
	Extending one .RAN with CHIRPS (method A, docs/theory/extend.md): upload
	the area, fetch CHIRPS, look at the overlap fit, edit the 12 factors,
	preview the appended years, apply. Every step's logic is in the .ts
	modules beside this file (tested there); this component holds the state.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { stripExtension, type ChirpsMonthly, type ExtensionFit, type ExtensionResult, type FitStatistics, type RainfallSeries } from '@pitman/wrsm';
	import { calendarYear, formatNumber, hydroYearLabel } from '#lib/results/format.js';
	import { parseArea, parseQuaternaries, type ParsedArea } from './area.js';
	import { isoDate } from './apply.js';
	import { annualChart, meansChart, scatterChart, scatterPoints } from './charts.js';
	import { monthlyBias, summaryStats } from './diagnostics.js';
	import type { ExtensionEngine } from './engine.js';
	import {
		MONTH_NAMES,
		blockingMessages,
		factorNotes,
		factorRows,
		factorsForDisplay,
		factorsInUse,
		editsFromSaved,
		initialEdits,
		resetEdit,
		type FactorEdit
	} from './factors.js';
	import type { RainfallFileEntry } from './files.js';
	import FactorTable from './FactorTable.svelte';
	import FitChart from './FitChart.svelte';
	import { chirpsFacts, fitFacts, previousExtension, revisionNote } from './provenance.js';
	import { checkWindow, fitExtension, missingInOverlap, partialYear, previewExtension, rowTotal, windowYears, type YearRange } from './session.js';

	let {
		entry,
		series,
		engine,
		fetchChirps,
		onapplied,
		onclose
	}: {
		entry: RainfallFileEntry;
		/** The file as it is in the working copy (an earlier extension's rows included; they are stripped before fitting). */
		series: RainfallSeries;
		engine: ExtensionEngine;
		fetchChirps: (area: ParsedArea['geometry'], signal: AbortSignal) => Promise<ChirpsMonthly>;
		onapplied: (result: ExtensionResult, summary: string) => void;
		onclose: () => void;
	} = $props();

	/** The original record: what is fitted and extended (R4-E2). */
	const ran = $derived(entry.extension ? stripExtension(series, entry.extension) : series);
	const p = $derived(`extend-${entry.key.replace(/[^A-Za-z0-9]+/g, '-')}`);

	let area = $state.raw<ParsedArea | undefined>();
	let areaName = $state('');
	let areaError = $state<string | undefined>();
	let quaternaryText = $state('');
	const quaternaries = $derived(parseQuaternaries(quaternaryText));

	type FetchState = 'idle' | 'fetching' | 'done' | 'failed';
	let fetchState = $state<FetchState>('idle');
	let fetchError = $state<string | undefined>();
	let chirps = $state.raw<ChirpsMonthly | undefined>();
	let accessed = $state('');
	let controller: AbortController | undefined;

	let fit = $state.raw<ExtensionFit | undefined>();
	let fitError = $state<string | undefined>();
	let whole = $state.raw<YearRange | undefined>();
	let windowStart = $state(0);
	let windowEnd = $state(0);
	let windowError = $state<string | undefined>();

	let edits = $state<FactorEdit[]>([]);
	let corrected = $state(false);
	let scatterMonth = $state<number | 'all'>('all');
	let applyError = $state<string | undefined>();
	let showBlocking = $state(false);

	const rows = $derived(fit ? factorRows(fit, edits, engine.check) : []);
	const display = $derived(fit ? factorsForDisplay(rows) : undefined);
	const inUse = $derived(factorsInUse(rows));
	const blocking = $derived(blockingMessages(rows));
	const provenance = $derived({
		file: entry.name,
		quaternaries: quaternaries.codes,
		accessed,
		factorNotes: factorNotes(rows)
	});
	const preview = $derived(
		fit && chirps && inUse && fit.appendable ? previewExtension(engine, ran, chirps, fit, inUse, provenance) : undefined
	);
	const points = $derived(fit && display ? scatterPoints(fit, ran, display, corrected).filter((pt) => scatterMonth === 'all' || pt.month === scatterMonth) : []);
	const scatter = $derived(fit && display ? scatterChart(fit, ran, display, corrected, scatterMonth === 'all' ? null : scatterMonth) : undefined);
	const means = $derived(fit && display ? meansChart(fit, display) : undefined);
	const annual = $derived(fit && display ? annualChart(fit, ran, display) : undefined);
	const partial = $derived(chirps ? partialYear(chirps) : null);
	const missing = $derived(fit ? missingInOverlap(fit) : []);
	/** The engine's statistics with the factors in use, when any is edited (the fit's own `after` uses the computed ones). */
	const inUseStats = $derived.by((): FitStatistics | null => {
		if (!fit || !display || !rows.some((r) => r.edited)) return null;
		try {
			return engine.statistics(ran, fit, display);
		} catch {
			return null;
		}
	});
	const revision = $derived(entry.extension && chirps ? revisionNote(entry.extension, chirps) : '');

	async function focusById(id: string) {
		await tick();
		document.getElementById(id)?.focus();
	}

	async function readArea(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		resetFetch();
		area = undefined;
		areaError = undefined;
		if (!file) return;
		areaName = file.name;
		let text: string;
		try {
			text = await file.text();
		} catch {
			areaError = `${file.name} could not be read.`;
			void focusById(`${p}-area`);
			return;
		}
		const parsed = parseArea(text);
		if (parsed.ok) area = parsed;
		else {
			areaError = parsed.error;
			void focusById(`${p}-area`);
		}
	}

	function resetFetch() {
		controller?.abort();
		controller = undefined;
		fetchState = 'idle';
		fetchError = undefined;
		chirps = undefined;
		fit = undefined;
		fitError = undefined;
		whole = undefined;
		applyError = undefined;
		showBlocking = false;
	}

	async function fetchSeries() {
		if (!area) return;
		resetFetch();
		fetchState = 'fetching';
		controller = new AbortController();
		const signal = controller.signal;
		try {
			const result = await fetchChirps(area.geometry, signal);
			if (signal.aborted) return;
			chirps = result;
			accessed = isoDate();
			fetchState = 'done';
			runFit(undefined, true);
		} catch (error) {
			if ((error as Error).name === 'AbortError') {
				fetchState = 'idle';
				return;
			}
			fetchState = 'failed';
			fetchError = (error as Error).message;
			void focusById(`${p}-fetch-error`);
		} finally {
			controller = undefined;
		}
	}

	function runFit(window: YearRange | undefined, first = false) {
		if (!chirps) return;
		let next: ExtensionFit;
		let saved: { used: number[]; notes: string[] } | undefined;
		try {
			if (first && entry.extension) {
				// Re-extending (R4-E2): the recorded overlap, MAP_c and factors.
				const refit = engine.refit(series, chirps, entry.extension);
				next = refit.fit;
				saved = { used: [...refit.factors], notes: entry.extension.factors.map((f) => (f.edited ? f.note : '')) };
			} else {
				const outcome = fitExtension(engine, ran, chirps, window);
				if (!outcome.ok) throw new Error(outcome.error);
				next = outcome.value;
			}
		} catch (error) {
			fitError = (error as Error).message || 'The fit failed without saying why.';
			if (first) fit = undefined;
			void focusById(`${p}-fit-error`);
			return;
		}
		fitError = undefined;
		if (first || !whole) {
			// The window's choices: the whole overlap of a fresh fit (a refit may be on a narrowed, recorded window).
			const fresh = first && entry.extension ? fitExtension(engine, ran, chirps) : undefined;
			const wholeFit = fresh?.ok ? fresh.value : next;
			whole = { startYear: wholeFit.overlap.startYear, endYear: wholeFit.overlap.endYear };
			edits = saved ? editsFromSaved(next, saved.used, saved.notes) : initialEdits(next);
		} else {
			// Keep what the user typed; untouched months follow the new computed factors.
			edits = next.factors.map((f, i) => (edits[i]?.typed ? (edits[i] as FactorEdit) : resetEdit(f)));
		}
		windowStart = next.overlap.startYear;
		windowEnd = next.overlap.endYear;
		fit = next;
	}

	function applyWindow() {
		if (!whole) return;
		const checked = checkWindow(windowStart, windowEnd, whole);
		if (!checked.ok) {
			windowError = checked.error;
			void focusById(`${p}-window-start`);
			return;
		}
		windowError = undefined;
		runFit(checked.value);
	}

	function resetWindow() {
		windowError = undefined;
		runFit(undefined);
	}

	function edit(index: number, next: FactorEdit) {
		edits[index] = next;
		applyError = undefined;
	}

	function reset(index: number) {
		if (!fit) return;
		edits[index] = resetEdit(fit.factors[index] as ExtensionFit['factors'][number]);
		void focusById(`factor-${index}`);
	}

	function apply() {
		applyError = undefined;
		if (!fit || !fit.appendable) return;
		if (blocking.length > 0 || !inUse) {
			showBlocking = true;
			const first = rows.find((r) => r.blocking);
			if (first) void focusById(first.check === 'confirmZero' && first.inUse === 0 ? `factor-${first.index}-zero` : `factor-${first.index}`);
			return;
		}
		if (!preview || !preview.ok) {
			applyError = preview && !preview.ok ? preview.error : 'The extension could not be computed.';
			void focusById(`${p}-apply-error`);
			return;
		}
		const n = preview.value.appended.length;
		onapplied(
			preview.value.result,
			`${entry.name} now runs to ${hydroYearLabel(fit.appendable.lastYear)}: ${n} CHIRPS-derived year${n === 1 ? '' : 's'} appended.`
		);
	}

	$effect(() => () => controller?.abort());
</script>

<section class="file" aria-labelledby={`${p}-h`} data-file={entry.key}>
	<div class="head">
		<h3 id={`${p}-h`} tabindex="-1">Extend {entry.name}</h3>
		<button type="button" onclick={onclose}>Close</button>
	</div>
	<p class="note">
		Zone {entry.code}, {hydroYearLabel(ran.rows[0]?.year ?? entry.firstYear)} to {hydroYearLabel(ran.rows[ran.rows.length - 1]?.year ?? entry.lastYear)}
		{#if entry.extension}(the original record){/if}.
	</p>
	{#if entry.extension}
		<p class="note">{previousExtension(entry.extension)}</p>
	{/if}

	<h4>1. The area this file represents</h4>
	<p>
		Upload the boundary the rainfall file stands for (usually its quaternaries) as GeoJSON in longitude/latitude: a Polygon, a MultiPolygon, or a
		FeatureCollection of them. Only the shape is sent to Pitman’s rainfall service, never the network’s files.
	</p>
	<div class="field">
		<input
			id={`${p}-area`}
			class="file-pick"
			type="file"
			accept=".geojson,.json,application/geo+json,application/json"
			aria-invalid={areaError ? 'true' : undefined}
			aria-describedby={areaError ? `${p}-area-error` : undefined}
			onchange={readArea}
			disabled={fetchState === 'fetching'}
		/>
		<label for={`${p}-area`}>Boundary file (GeoJSON)</label>
	</div>
	{#if areaError}
		<p id={`${p}-area-error`} class="error" role="alert">{areaName ? `${areaName}: ` : ''}{areaError}</p>
	{/if}
	{#if area}
		<dl class="facts" aria-label="The uploaded area">
			<div><dt>File</dt><dd>{areaName}</dd></div>
			<div><dt>Area</dt><dd data-value="area-km2">{formatNumber(area.areaKm2, 1)} km² (on the sphere; the service’s geodesic figure follows)</dd></div>
			<div><dt>Shape</dt><dd>{area.polygons} polygon{area.polygons === 1 ? '' : 's'}{area.holes ? `, ${area.holes} hole${area.holes === 1 ? '' : 's'}` : ''}, {area.vertices.toLocaleString('en-ZA')} vertices</dd></div>
			<div>
				<dt>Extent</dt>
				<dd>{formatNumber(area.bbox.west, 3)}° to {formatNumber(area.bbox.east, 3)}° E, {formatNumber(-area.bbox.north, 3)}° to {formatNumber(-area.bbox.south, 3)}° S</dd>
			</div>
		</dl>
		{#each area.warnings as warning (warning)}
			<p class="warn"><strong>Check:</strong> {warning}</p>
		{/each}
		<div class="field">
			<label for={`${p}-quaternaries`}>Quaternaries this area covers (optional, recorded with the extension)</label>
			<input
				id={`${p}-quaternaries`}
				type="text"
				autocomplete="off"
				spellcheck="false"
				placeholder="e.g. H80A, H80B"
				bind:value={quaternaryText}
				aria-describedby={quaternaries.invalid.length ? `${p}-quaternaries-error` : undefined}
			/>
		</div>
		{#if quaternaries.invalid.length > 0}
			<p id={`${p}-quaternaries-error`} class="warn">
				<strong>Check:</strong> not a quaternary code (a letter, two digits, a letter): {quaternaries.invalid.join(', ')}. Only valid codes are recorded.
			</p>
		{/if}

		<h4>2. CHIRPS over the area</h4>
		<div class="actions">
			<button type="button" class="primary" onclick={fetchSeries} disabled={fetchState === 'fetching'}>
				{chirps ? 'Fetch CHIRPS again' : 'Fetch CHIRPS for this area'}
			</button>
			{#if fetchState === 'fetching'}
				<button type="button" onclick={() => controller?.abort()}>Cancel</button>
				<p class="note" role="status">Fetching the monthly CHIRPS record (1981 to the latest final month)…</p>
			{/if}
		</div>
		{#if fetchError}
			<p id={`${p}-fetch-error`} class="error" role="alert" tabindex="-1">The CHIRPS series could not be fetched: {fetchError}</p>
		{/if}
	{/if}

	{#if chirps}
		<dl class="facts provenance" aria-label="Where the CHIRPS numbers come from" data-provenance="chirps">
			{#each chirpsFacts(chirps, accessed) as fact (fact.label)}
				<div><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
			{/each}
		</dl>
		{#if revision}
			<p class="warn"><strong>Check:</strong> {revision}</p>
		{/if}
		{#if partial}
			<p class="note">
				CHIRPS holds {partial.months} month{partial.months === 1 ? '' : 's'} of {hydroYearLabel(partial.year)}; a partial hydrological year is never appended.
			</p>
		{/if}
	{/if}

	{#if fitError}
		<p id={`${p}-fit-error`} class="error" role="alert" tabindex="-1">{fitError}</p>
	{/if}

	{#if fit && chirps && whole && display && scatter && means && annual}
		<h4>3. The overlap fit</h4>
		<dl class="facts provenance" aria-label="The fit" data-provenance="fit">
			{#each fitFacts(fit) as fact (fact.label)}
				<div><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
			{/each}
		</dl>
		{#if fit.messages.length > 0}
			<ul class="messages" aria-label="About the fit">
				{#each fit.messages as message, i (i)}
					<li class={message.level}>
						<strong>{message.level === 'error' ? 'Problem:' : message.level === 'warning' ? 'Warning:' : 'Note:'}</strong>
						{message.text}
					</li>
				{/each}
			</ul>
		{/if}
		{#if missing.length > 0}
			<p class="note">
				CHIRPS months missing inside the overlap (each leaves that year out of its month’s factor only):
				{missing.map((m) => `${MONTH_NAMES[m.month]} ${calendarYear(m.year, m.month)}`).join(', ')}.
			</p>
		{/if}

		<fieldset class="window">
			<legend>Overlap window (decision D5)</legend>
			<p class="note">
				The factors are fitted on the whole overlap, {hydroYearLabel(whole.startYear)} to {hydroYearLabel(whole.endYear)}, unless you narrow it.
			</p>
			<div class="window-row">
				<div class="field">
					<label for={`${p}-window-start`}>First year</label>
					<select id={`${p}-window-start`} bind:value={windowStart} aria-describedby={windowError ? `${p}-window-error` : undefined}>
						{#each windowYears(whole) as y (y)}<option value={y}>{hydroYearLabel(y)}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for={`${p}-window-end`}>Last year</label>
					<select id={`${p}-window-end`} bind:value={windowEnd} aria-describedby={windowError ? `${p}-window-error` : undefined}>
						{#each windowYears(whole) as y (y)}<option value={y}>{hydroYearLabel(y)}</option>{/each}
					</select>
				</div>
			</div>
			<div class="actions">
				<button type="button" onclick={applyWindow}>Fit on this window</button>
				<button type="button" onclick={resetWindow} disabled={fit.overlap.window === 'default'}>Reset to the whole overlap</button>
			</div>
			{#if windowError}
				<p id={`${p}-window-error`} class="error" role="alert">{windowError}</p>
			{/if}
		</fieldset>

		<FitChart spec={scatter} {points}>
			{#snippet controls()}
				<div class="toggle">
					<input type="checkbox" id={`${p}-corrected`} bind:checked={corrected} />
					<label for={`${p}-corrected`}>Show corrected CHIRPS (f × p) instead of p</label>
				</div>
				<div class="field inline">
					<label for={`${p}-month`}>Months shown</label>
					<select id={`${p}-month`} bind:value={scatterMonth}>
						<option value="all">All months</option>
						{#each MONTH_NAMES as name, k (name)}<option value={k}>{name}</option>{/each}
					</select>
				</div>
			{/snippet}
		</FitChart>
		<FitChart spec={means} />
		<FitChart spec={annual} />

		<div class="scroll">
			<table class="data" data-table="fit-statistics">
				<caption>Fit over the overlap, before (p) and after (f × p)</caption>
				<thead>
					<tr>
						<th scope="col">Measure</th><th scope="col">Before</th><th scope="col">After, computed factors</th>
						{#if inUseStats}<th scope="col">With the factors in use</th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each summaryStats(fit, inUseStats) as row (row.label)}
						<tr data-statistic={row.label}>
							<th scope="row">{row.label}</th><td>{row.before}</td><td>{row.after}</td>
							{#if inUseStats}<td>{row.inUse}</td>{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div class="scroll">
			<table class="data" data-table="monthly-bias">
				<caption>Bias by month, 100 × (Σ CHIRPS − Σ file) / Σ file</caption>
				<thead>
					<tr><th scope="col">Month</th><th scope="col">Before</th><th scope="col">After, computed factors</th><th scope="col">With the factors in use</th></tr>
				</thead>
				<tbody>
					{#each monthlyBias(fit, rows, inUseStats) as row (row.month)}
						<tr><th scope="row">{row.month}</th><td>{row.before}</td><td>{row.afterComputed}</td><td>{row.inUse}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">
			A computed factor reproduces the file’s mean for its month over the overlap exactly, so its bias after correction is 0 by construction; R² barely moves under
			a per-month scaling, so NSE is the more telling “after” number.
		</p>

		<h4>4. The 12 factors</h4>
		<p>Each factor multiplies CHIRPS’ % of its MAP for that month. Type a value to override it (0 to 5), or reset it to the computed one.</p>
		<FactorTable {rows} onedit={edit} onreset={reset} />

		<h4>5. The appended years</h4>
		{#if !fit.appendable}
			<p class="note" data-appendable="none">Nothing to append: {entry.name} already reaches the last complete CHIRPS hydrological year. The fit is shown for information.</p>
		{:else}
			<p>
				With these factors, {hydroYearLabel(fit.appendable.firstYear)} to {hydroYearLabel(fit.appendable.lastYear)} would be appended ({fit.appendable.lastYear -
					fit.appendable.firstYear +
					1} years, % of MAP, two decimals as the file holds them).
			</p>
		{/if}
		{#if fit.stoppedAt}
			<p class="warn">
				<strong>Stops early:</strong> CHIRPS has no value for {MONTH_NAMES[fit.stoppedAt.month]}
				{calendarYear(fit.stoppedAt.year, fit.stoppedAt.month)} ({hydroYearLabel(fit.stoppedAt.year)}), so the extension stops before that year. Years are appended
				without gaps.
			</p>
		{/if}
		{#if fit.appendable && preview?.ok}
			<div class="scroll">
				<table class="data preview" data-table="preview">
					<caption>Preview: the rows the apply adds to {entry.name}</caption>
					<thead>
						<tr>
							<th scope="col">Year</th>
							{#each MONTH_NAMES as name (name)}<th scope="col">{name.slice(0, 3)}</th>{/each}
							<th scope="col">Total</th>
						</tr>
					</thead>
					<tbody>
						{#each preview.value.appended as row (row.year)}
							<tr>
								<th scope="row">{hydroYearLabel(row.year)}</th>
								{#each row.months as v, k (k)}<td>{formatNumber(v, 2)}</td>{/each}
								<td>{formatNumber(rowTotal(row), 2)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else if fit.appendable && preview && !preview.ok}
			<p class="error">The preview could not be computed: {preview.error}</p>
		{:else if fit.appendable && !inUse}
			<p class="note">The preview appears once every factor can be used.</p>
		{/if}

		{#if fit.appendable}
			<h4>6. Apply</h4>
			<p>
				Applying replaces {entry.name} in this browser’s working copy (the original rows stay as they are) and records the CHIRPS product, revision, cells, area,
				overlap and factors in <code>pitman.json</code>. Save the zip to keep it.
			</p>
			{#if showBlocking && blocking.length > 0}
				<div class="blocking" role="alert">
					<p><strong>Fix these before applying:</strong></p>
					<ul>
						{#each blocking as b (b.index)}<li>{b.text}</li>{/each}
					</ul>
				</div>
			{/if}
			<div class="actions">
				<button type="button" class="primary" onclick={apply}>Apply: append {fit.appendable.lastYear - fit.appendable.firstYear + 1} years to {entry.name}</button>
			</div>
			{#if applyError}
				<p id={`${p}-apply-error`} class="error" role="alert" tabindex="-1">The extension could not be applied: {applyError}</p>
			{/if}
		{/if}
	{/if}
</section>

<style>
	.file {
		border: 1px solid var(--border);
		border-top: 3px solid var(--accent);
		border-radius: var(--radius-lg);
		background: var(--surface-2);
		margin-top: 1.25rem;
		padding: 0.75rem 1.25rem 1.25rem;
	}
	@media (max-width: 40rem) {
		.file {
			padding: 0.5rem 0.75rem 1rem;
		}
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}
	h3 {
		margin: 0.5rem 0;
		font-size: 1.15rem;
		overflow-wrap: anywhere;
	}
	h4 {
		font-size: 1rem;
		margin: 1.75rem 0 0.5rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}
	.field {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
		margin: 0.5rem 0;
	}
	.field.inline {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
	}
	.toggle {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		min-height: var(--control-h);
	}
	/* Inside the inset panel a tile lifts off it, the other way round from a card. */
	.file :global(.facts > div) {
		background: var(--surface);
	}
	.window {
		background: var(--surface);
		margin: 1rem 0;
	}
	.window-row {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
	}
	.messages {
		padding-left: 1.25rem;
	}
	.messages li.warning,
	.messages li.error {
		border-left: 4px solid var(--warning);
		padding-left: 0.5rem;
		list-style: none;
		margin-left: -1.25rem;
	}
	.messages li.error {
		border-left-color: var(--danger);
	}
	.blocking {
		background: var(--danger-soft);
		border: 2px solid var(--danger);
		border-radius: var(--radius-lg);
		padding: 0.25rem 1rem;
	}
	.scroll {
		margin: 0.75rem 0;
	}
	.preview {
		font-size: var(--font-sm);
	}
</style>
