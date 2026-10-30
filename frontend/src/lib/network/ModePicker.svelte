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
	<div class="options">
		<div class="option">
			<div class="mode">
				<input id="mode-present" type="checkbox" bind:checked={choice.presentDay} />
				<label for="mode-present"><strong>Present day:</strong> development held at one year over the whole rainfall record</label>
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
		</div>
		<div class="option">
			<div class="mode">
				<input id="mode-natural" type="checkbox" bind:checked={choice.natural} />
				<label for="mode-natural"><strong>Natural:</strong> irrigation, dams, abstractions, streamflow reduction (afforestation, alien vegetation) and paved areas removed</label>
			</div>
		</div>
		<div class="option">
			<div class="mode">
				<input id="mode-historical" type="checkbox" bind:checked={choice.historical} />
				<label for="mode-historical"><strong>Historical:</strong> development changing year by year, as the files give it</label>
			</div>
		</div>
	</div>
	{#if error}
		<p id="mode-error" class="error" role="alert">{error}</p>
	{/if}
</fieldset>

<style>
	fieldset {
		border: 0;
		padding: 0;
	}
	legend {
		padding: 0;
		margin-bottom: 0.5rem;
	}
	.options {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
		gap: 0.75rem;
	}
	.option {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface-2);
		padding: 0.75rem 0.9rem;
		min-width: 0;
		font-size: 0.925rem;
	}
	.option:has(.mode input:checked) {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
		background: var(--surface);
	}
	.mode {
		display: flex;
		gap: 0.6rem;
		align-items: flex-start;
	}
	.mode input {
		margin-top: 0.15rem;
	}
	.year {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.6rem;
		align-items: center;
		margin: 0.6rem 0 0 1.725rem;
	}
	.year input {
		width: 5rem;
	}
	.hint {
		color: var(--text-muted);
		font-size: var(--font-sm);
		flex-basis: 100%;
	}
	.error {
		margin: 0.5rem 0 0;
	}
</style>
