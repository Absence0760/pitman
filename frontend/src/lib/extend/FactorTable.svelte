<!--
	The 12 bias factors (extend.md § Step 6): per month the computed value,
	the value in use, the engine's note, the overlap means behind it, an input,
	reset-to-computed, a confirmation for 0 and the user's own note. The rows
	come from factors.ts (factorRows); this component only renders them and
	reports edits.
-->
<script lang="ts">
	import { formatNumber } from '#lib/results/format.js';
	import { flagLabel, formatFactor, type FactorEdit, type FactorRow } from './factors.js';

	let { rows, onedit, onreset }: { rows: readonly FactorRow[]; onedit: (index: number, edit: FactorEdit) => void; onreset: (index: number) => void } = $props();

	const anyEdited = $derived(rows.some((r) => r.edit.typed));
</script>

<div class="factors">
	{#each rows as row (row.index)}
		{@const id = `factor-${row.index}`}
		{@const msgId = `factor-${row.index}-msg`}
		<fieldset class="month" class:blocking={row.blocking} data-month={row.index} data-check={row.check}>
			<legend>{row.month}</legend>
			<dl>
				<div><dt>Computed</dt><dd data-value="computed">{formatFactor(row.fit.computed)}</dd></div>
				<div>
					<dt>In use</dt>
					<dd data-value="in-use">
						{row.inUse === null ? 'none (fix the value)' : formatFactor(row.inUse)}{row.edited ? ' (edited)' : ''}
					</dd>
				</div>
				<div><dt>Overlap mean, file</dt><dd>{formatNumber(row.fit.meanFilePct, 3)} % of MAP</dd></div>
				<div><dt>Overlap mean, CHIRPS</dt><dd>{formatNumber(row.fit.meanChirpsPct, 3)} % of CHIRPS MAP</dd></div>
				<div><dt>Years used</dt><dd>{row.fit.years}</dd></div>
			</dl>
			<p class="note">{row.fit.note || flagLabel(row.fit.flag)}</p>
			<div class="input">
				<label for={id}>{row.month} factor</label>
				<div class="row">
					<input
						{id}
						type="text"
						inputmode="decimal"
						autocomplete="off"
						spellcheck="false"
						value={row.edit.text}
						aria-invalid={row.blocking && row.check === 'refused' ? 'true' : undefined}
						aria-describedby={row.message ? msgId : undefined}
						oninput={(e) => onedit(row.index, { ...row.edit, text: e.currentTarget.value, typed: true, confirmedZero: false })}
					/>
					<button type="button" onclick={() => onreset(row.index)} disabled={!row.edit.typed} aria-label={`Reset ${row.month} to the computed factor`}>Reset</button>
				</div>
			</div>
			{#if row.message}
				<p id={msgId} class="msg" class:error={row.check === 'refused'} class:warn={row.check !== 'refused'}>
					<strong>{row.check === 'refused' || row.blocking ? 'Needs attention:' : 'Check:'}</strong>
					{row.message}
				</p>
			{/if}
			{#if row.check === 'confirmZero'}
				<div class="check">
					<input
						type="checkbox"
						id={`${id}-zero`}
						checked={row.edit.confirmedZero}
						onchange={(e) => onedit(row.index, { ...row.edit, confirmedZero: e.currentTarget.checked })}
					/>
					<label for={`${id}-zero`}>Yes, no rain in every appended {row.month}</label>
				</div>
			{/if}
			{#if row.edited}
				<div class="input">
					<label for={`${id}-note`}>Why you changed it (kept in pitman.json)</label>
					<input
						type="text"
						id={`${id}-note`}
						value={row.edit.note}
						maxlength="200"
						oninput={(e) => onedit(row.index, { ...row.edit, note: e.currentTarget.value })}
					/>
				</div>
			{/if}
		</fieldset>
	{/each}
</div>
{#if anyEdited}
	<p class="hint">Edited factors are relative to the CHIRPS % of MAP shown here; the charts and the preview use the values in use.</p>
{/if}

<style>
	.factors {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
		gap: 0.75rem;
	}
	.month {
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		padding: 0.5rem 0.75rem 0.75rem;
		margin: 0;
		min-width: 0;
		background: var(--surface);
	}
	.month.blocking {
		border-color: var(--danger);
		border-width: 2px;
	}
	legend {
		font-weight: 600;
		padding: 0 0.25rem;
	}
	dl {
		margin: 0;
		font-size: 0.875rem;
		font-variant-numeric: tabular-nums;
	}
	dl div {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
	}
	dt {
		color: var(--text-muted);
	}
	dd {
		margin: 0;
		text-align: right;
	}
	.note {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin: 0.35rem 0;
	}
	.input {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-top: 0.4rem;
	}
	.input label {
		font-size: 0.875rem;
	}
	.row {
		display: flex;
		gap: 0.5rem;
	}
	input[type='text'] {
		font: inherit;
		min-height: 2.75rem;
		padding: 0 0.5rem;
		border: 1px solid var(--border-strong);
		border-radius: 0.375rem;
		background: var(--bg);
		color: var(--text);
		min-width: 0;
		flex: 1;
	}
	input[aria-invalid='true'] {
		border: 2px solid var(--danger);
	}
	button {
		font: inherit;
		min-height: 2.75rem;
		padding: 0 0.75rem;
		border-radius: 0.375rem;
		border: 1px solid var(--border-strong);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.msg {
		font-size: 0.875rem;
		margin: 0.35rem 0 0;
		padding-left: 0.5rem;
		border-left: 4px solid var(--warning);
	}
	.msg.error {
		border-left-color: var(--danger);
		color: var(--danger);
	}
	.check {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		min-height: 2.75rem;
		font-size: 0.875rem;
	}
	.check input {
		width: 1.25rem;
		height: 1.25rem;
	}
	.hint {
		font-size: 0.875rem;
		color: var(--text-muted);
	}
</style>
