<!--
	Run modes (decision D1): present day at a chosen year (2025 by default),
	natural, historical. Several can be ticked so their results compare.
-->
<script lang="ts">
	import { PRESENT_DAY_YEARS, type ModeChoice } from './modes.js';

	let {
		choice = $bindable(),
		error,
		errorField,
		disabled = false
	}: { choice: ModeChoice; error?: string; errorField?: 'year' | 'modes'; disabled?: boolean } = $props();
</script>

<fieldset {disabled} aria-describedby={error ? 'mode-error' : undefined}>
	<legend>Run modes</legend>
	<div class="mode">
		<input id="mode-present" type="checkbox" bind:checked={choice.presentDay} />
		<label for="mode-present">Present day: development held at one year over the whole rainfall record</label>
	</div>
	<div class="year">
		<label for="mode-year">Present-day year</label>
		<input
			id="mode-year"
			type="text"
			inputmode="numeric"
			autocomplete="off"
			size="6"
			maxlength="4"
			disabled={!choice.presentDay}
			aria-invalid={errorField === 'year'}
			aria-describedby="mode-year-hint"
			bind:value={choice.presentDayYear}
		/>
		<span id="mode-year-hint" class="hint">Hydrological year (October to September), {PRESENT_DAY_YEARS.min}–{PRESENT_DAY_YEARS.max}</span>
	</div>
	<div class="mode">
		<input id="mode-natural" type="checkbox" bind:checked={choice.natural} />
		<label for="mode-natural">Natural: irrigation, dams, abstractions, streamflow reduction (afforestation, alien vegetation) and paved areas removed</label>
	</div>
	<div class="mode">
		<input id="mode-historical" type="checkbox" bind:checked={choice.historical} />
		<label for="mode-historical">Historical: development changing year by year, as the files give it</label>
	</div>
	{#if error}
		<p id="mode-error" class="error" role="alert">{error}</p>
	{/if}
</fieldset>

<style>
	fieldset {
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		padding: 0.75rem 1rem 1rem;
		margin: 0;
	}
	legend {
		font-weight: 600;
		padding: 0 0.25rem;
	}
	.mode {
		display: flex;
		gap: 0.6rem;
		align-items: flex-start;
		margin: 0.6rem 0;
	}
	.mode input {
		width: 1.25rem;
		height: 1.25rem;
		margin: 0.1rem 0 0;
		flex: none;
	}
	.year {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.6rem;
		align-items: baseline;
		margin: 0 0 0.6rem 1.85rem;
	}
	.year input {
		font: inherit;
		min-height: 2.5rem;
		padding: 0 0.5rem;
		border: 1px solid var(--border-strong);
		border-radius: 0.25rem;
		background: var(--surface);
		color: var(--text);
		width: 5.5rem;
	}
	.year input[aria-invalid='true'] {
		border-color: var(--danger);
	}
	.hint {
		color: var(--text-muted);
		font-size: 0.9rem;
		flex-basis: 100%;
	}
	.error {
		color: var(--danger);
		margin: 0.5rem 0 0;
		font-weight: 600;
	}
</style>
