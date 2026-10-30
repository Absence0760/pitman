<!--
	Step 4: the target and the D2 loop (subdivide.md § Calibration). The WR2012
	value is typed with its citation, the unsplit natural run is always beside
	it, and every try is on the page. A calibration that did not converge
	offers exactly three things, and only "Use the best factor" reaches Apply.
-->
<script lang="ts">
	import { formatNumber } from '#lib/results/format.js';
	import { TOLERANCE_PCT, formatMar, formatScale, iterationRows, mayApply, outcomeSentence, roundingWarning, type CalibrationOutcome } from './calibration.js';
	import type { PieceRow } from './pieces.js';
	import { UNSPLIT_TARGET_SOURCE, crossCheckOf, periodLabel, typedCrossCheckWarning, type UnsplitNatural } from './target.js';

	let {
		rows,
		unsplit,
		unsplitError,
		marText = $bindable(),
		citation = $bindable(),
		targetError,
		calibrating,
		calibrationError,
		outcome,
		stale,
		oncalibrate,
		onbest,
		onchangetarget,
		oncancel,
		oncontinue
	}: {
		rows: readonly PieceRow[];
		unsplit: UnsplitNatural | undefined;
		unsplitError: string | undefined;
		marText: string;
		citation: string;
		targetError: { field: 'mar' | 'citation'; text: string } | undefined;
		calibrating: boolean;
		calibrationError: string | undefined;
		outcome: CalibrationOutcome | undefined;
		/** The bundle or the target changed since this calibration. */
		stale: boolean;
		oncalibrate: () => void;
		onbest: () => void;
		onchangetarget: () => void;
		oncancel: () => void;
		oncontinue: () => void;
	} = $props();

	const crossCheck = $derived(unsplit ? crossCheckOf(unsplit) : undefined);
	const warning = $derived(crossCheck ? typedCrossCheckWarning(marText, crossCheck.marMm3) : null);
	const log = $derived(outcome ? iterationRows(outcome.result) : []);
	const rounding = $derived(outcome ? roundingWarning(outcome.result, outcome.target) : null);
	const status = $derived(outcome?.result.status);
</script>

<p>
	Pitman multiplies every piece’s MAP by one factor, so the ratios between pieces stay as they are, until the natural runoff the pieces generate matches a target for the
	quaternary, within {TOLERANCE_PCT} %. Only the years before any CHIRPS extension count, because those are the years WR2012 covers. Nothing changes in the network here.
</p>

{#if unsplitError}
	<p class="error" role="alert">The unsplit natural run could not be computed: {unsplitError}</p>
{/if}

<div class="target">
	<div class="input">
		<label for="subdivide-mar">WR2012 natural MAR for this quaternary, million m³/year</label>
		<input
			id="subdivide-mar"
			type="text"
			inputmode="decimal"
			autocomplete="off"
			spellcheck="false"
			bind:value={marText}
			aria-invalid={targetError?.field === 'mar' ? 'true' : undefined}
			aria-describedby={targetError?.field === 'mar' ? 'subdivide-target-error' : 'subdivide-mar-hint'}
		/>
		<p id="subdivide-mar-hint" class="hint">From WR2012’s tables, for the whole quaternary. Leave it empty to use the unsplit natural run instead.</p>
	</div>
	<div class="input">
		<label for="subdivide-citation">Where the value comes from: volume and table</label>
		<input
			id="subdivide-citation"
			type="text"
			autocomplete="off"
			placeholder="e.g. WR2012 (WRC 2015), volume, table"
			maxlength="200"
			bind:value={citation}
			aria-invalid={targetError?.field === 'citation' ? 'true' : undefined}
			aria-describedby={targetError?.field === 'citation' ? 'subdivide-target-error' : 'subdivide-citation-hint'}
		/>
		<p id="subdivide-citation-hint" class="hint">Kept in <code>pitman.json</code> with the value.</p>
	</div>
</div>
{#if targetError}
	<p id="subdivide-target-error" class="error" role="alert">{targetError.text}</p>
{/if}

{#if crossCheck && unsplit}
	<dl class="facts provenance" aria-label="The target and its cross-check" data-provenance="target">
		<div>
			<dt>Target in use</dt>
			<dd data-value="target">
				{#if marText.trim() === ''}
					{formatMar(crossCheck.marMm3)} million m³/year, {UNSPLIT_TARGET_SOURCE}
				{:else}
					{marText.trim()} million m³/year, hand-entered{citation.trim() ? `: ${citation.trim()}` : ''}
				{/if}
			</dd>
		</div>
		<div>
			<dt>Cross-check: the unsplit module</dt>
			<dd data-value="cross-check">{formatMar(crossCheck.marMm3)} million m³/year, natural run</dd>
		</div>
		<div>
			<dt>Years compared</dt>
			<dd>{periodLabel(unsplit.period)} (hydrological years, before any extension)</dd>
		</div>
	</dl>
	{#if warning}
		<p class="warn" data-warning="cross-check"><strong>Check:</strong> {warning}</p>
	{/if}
{/if}

<div class="actions">
	<button type="button" class="primary" onclick={oncalibrate} disabled={calibrating || unsplit === undefined}>{outcome ? 'Calibrate again' : 'Calibrate the MAPs'}</button>
	{#if calibrating}
		<p class="note" role="status">Running the pieces in natural mode…</p>
	{/if}
</div>
{#if calibrationError}
	<p class="error" role="alert">The calibration could not run: {calibrationError}</p>
{/if}

{#if outcome}
	<div class="result" id="subdivide-calibration-result" tabindex="-1" data-status={outcome.result.status} data-stale={stale ? 'true' : 'false'}>
		<h4>The result</h4>
		{#if stale}
			<p class="warn" data-state="stale"><strong>Out of date:</strong> the target or the network changed after this calibration. Calibrate again before applying.</p>
		{/if}
		<p class="state" class:ok={status === 'converged'} data-state="outcome">{outcomeSentence(outcome)}</p>
		{#if rounding}
			<p class="warn" data-warning="rounding"><strong>Check:</strong> {rounding}</p>
		{/if}

		{#if log.length > 0}
			<div class="scroll">
				<table class="data log" data-table="iterations">
					<caption>Every try, with the factor applied to each piece’s MAP</caption>
					<thead>
						<tr>
							<th scope="col">Try</th>
							<th scope="col">Step</th>
							<th scope="col">Factor</th>
							<th scope="col">MAR, million m³/year</th>
							<th scope="col">% from target</th>
							{#each rows as row (row.id)}<th scope="col">Piece {row.number} MAP, mm</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each log as it (it.n)}
							<tr class:mark={it.mark !== ''} data-iteration={it.n}>
								<th scope="row">{it.attempt}{it.mark ? ` (${it.mark})` : ''}</th>
								<td class="step">{it.step}</td>
								<td>{it.factor}</td>
								<td>{it.mar}</td>
								<td>{it.error}</td>
								{#each it.maps as map, i (i)}<td>{map}</td>{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="note">
				Runoff grows faster than rain, so the first step often overshoots and the next ones come back. “Held at a limit” means a step went past a factor of 0.5 or 2, or a MAP past
				1 to 12 000 mm, and was stopped there.
			</p>
		{/if}

		{#if outcome.result.status !== 'refused' && outcome.result.finalMapsMm.length > 0}
			<div class="scroll">
				<table class="data" data-table="final-maps">
					<caption>The MAPs {mayApply(outcome) ? 'that will be written' : 'at the best factor'}, rounded to whole mm as the file holds them</caption>
					<thead>
						<tr>
							<th scope="col">Piece</th>
							<th scope="col">Final MAP, mm</th>
							<th scope="col">Starting MAP, mm</th>
							<th scope="col">Factor</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row, i (row.id)}
							<tr>
								<th scope="row">{row.title}</th>
								<td data-value="final-map">{formatNumber(outcome.result.finalMapsMm[i], 0)}</td>
								<td>{formatNumber(row.map.value, 0)} ({row.map.source === 'typed' ? 'typed' : 'grid'})</td>
								<td>{outcome.result.best ? formatScale(outcome.result.best.s) : '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<dl class="facts" aria-label="The calibrated MAR">
				<div><dt>Natural MAR with these MAPs</dt><dd data-value="final-mar">{formatMar(outcome.result.finalMarMm3)} million m³/year</dd></div>
				<div><dt>Target</dt><dd>{formatMar(outcome.target.marMm3)} million m³/year</dd></div>
				<div><dt>Target’s source</dt><dd>{outcome.target.source}</dd></div>
			</dl>
		{/if}

		{#if !stale}
			{#if status === 'converged'}
				<div class="actions">
					<button type="button" class="primary" onclick={oncontinue}>Continue to apply</button>
				</div>
			{:else if status === 'not_converged' && !outcome.acceptNotConverged}
				<p>Nothing has been applied. What next?</p>
				<div class="actions" role="group" aria-label="What to do with this calibration">
					<button type="button" onclick={onbest} disabled={outcome.result.best === null}>Use the best factor</button>
					<button type="button" onclick={onchangetarget}>Change the target</button>
					<button type="button" onclick={oncancel}>Cancel</button>
				</div>
				<p class="note">“Use the best factor” records the calibration as not converged. “Cancel” goes back to the pieces; they stay as they are.</p>
			{:else if status === 'refused'}
				<p>Nothing has been applied. What next?</p>
				<div class="actions" role="group" aria-label="What to do with this calibration">
					<button type="button" onclick={onchangetarget}>Change the target</button>
					<button type="button" onclick={oncancel}>Cancel</button>
				</div>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.target {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
		gap: 0.75rem 1.25rem;
		margin: 0.75rem 0;
	}
	.input {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}
	.input input {
		width: 100%;
	}
	.hint {
		margin: 0;
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.result {
		margin-top: 1.25rem;
		padding-top: 0.25rem;
		border-top: 1px solid var(--border);
	}
	.result:focus-visible {
		outline-offset: 4px;
	}
	h4 {
		margin: 0.75rem 0 0.25rem;
	}
	.state {
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius);
		border-left: 4px solid var(--warning);
		background: var(--warning-soft);
		font-size: 0.9rem;
	}
	.state.ok {
		border-left-color: var(--success);
		background: var(--success-soft);
	}
	.log {
		font-size: var(--font-sm);
	}
	.log th,
	.log td {
		padding: 0.25rem 0.5rem;
	}
	.log .step,
	.log thead th:nth-child(2) {
		text-align: left;
	}
	/* Headers wrap so eight pieces' MAPs fit a wide screen without scrolling. */
	.log thead th {
		white-space: normal;
		vertical-align: bottom;
	}
	/* The try and its mark stay in view while a wide table of eight pieces scrolls. */
	.log tbody th,
	.log thead th:first-child {
		position: sticky;
		left: 0;
		background: var(--surface-2);
	}
	.log tr.mark td,
	.log tr.mark th {
		font-weight: 650;
	}
	.scroll {
		margin: 0.75rem 0;
	}
</style>
