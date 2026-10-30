<!--
	The matched dams with each one's source and alternatives, an override per
	dam with its note (rule 8), and the farm-dam reservoir's row (D4). The
	panel owns the match, so the map shows the same dams; overrides live here,
	and the panel keys this on the answer.
-->
<script lang="ts">
	import { scrollable } from '#lib/shell/scrollable.js';
	import { DEFAULT_MATCH_RADIUS_M, applyDams, damsRow, overrideDam, type DamRecord, type LoadedBundle } from '@pitman/wrsm';
	import { parseNumber } from '#lib/calibrate/validate.js';
	import { isoDate } from '#lib/extend/apply.js';
	import { formatNumber, hydroYearLabel } from '#lib/results/format.js';
	import { damName, reservoirChoices, sourceLabel } from './plan.js';

	let {
		bundle,
		dams,
		radiusM,
		year,
		busy = false,
		onradius,
		onapply,
		onrerun
	}: {
		bundle: LoadedBundle;
		/** The dams as matched at `radiusM`. */
		dams: readonly DamRecord[];
		radiusM: number;
		/** The row's year; `null` while what is typed isn't one. */
		year: number | null;
		busy?: boolean;
		onradius: (metres: number) => void;
		onapply: (next: LoadedBundle, status: string) => void;
		onrerun: () => void;
	} = $props();

	interface Override {
		readonly text: string;
		readonly note: string;
	}

	const choices = $derived(reservoirChoices(bundle));
	let picked = $state<number | undefined>();
	const reservoir = $derived(choices.find((c) => c.ref.number === picked) ?? choices[0]);
	let overrides = $state.raw<ReadonlyMap<string, Override>>(new Map());
	let error = $state<string | undefined>();
	let applied = $state<string | undefined>();

	const noteOf = (id: string) => overrides.get(id) ?? { text: '', note: '' };
	function edit(id: string, change: Partial<Override>) {
		overrides = new Map(overrides).set(id, { ...noteOf(id), ...change });
	}

	/** What is wrong with a dam's override, or `undefined`. */
	function problem(id: string): string | undefined {
		const { text, note } = noteOf(id);
		if (text.trim() === '') return note.trim() === '' ? undefined : 'Type the capacity this note is for.';
		const value = parseNumber(text);
		if (value === null || value < 0) return 'Type a capacity in million m³, 0 or more.';
		return note.trim() === '' ? 'Say where this figure came from.' : undefined;
	}

	const blocked = $derived(dams.filter((d) => problem(d.id) !== undefined));
	const used = $derived(
		dams.map((d) => {
			const { text, note } = noteOf(d.id);
			const value = parseNumber(text);
			return text.trim() !== '' && value !== null && value >= 0 && note.trim() !== '' ? overrideDam(d, value, note, isoDate()) : d;
		})
	);
	const row = $derived(damsRow(used));
	const unmeasured = $derived(used.filter((d) => d.areaKm2 === undefined).length);
	const noFigure = $derived(used.filter((d) => d.capacityMm3 === 0));
	const before = $derived(year === null ? undefined : reservoir?.rows.find((r) => r.year === year));
	const canApply = $derived(reservoir !== undefined && year !== null && row.fullSupplyVolumeMm3 > 0 && blocked.length === 0 && !busy);

	function apply() {
		if (!canApply || !reservoir || year === null) return;
		error = undefined;
		try {
			const next = applyDams(bundle, reservoir.ref, year, used);
			const status = `RV ${reservoir.ref.number}: ${formatNumber(row.fullSupplyVolumeMm3, 2)} million m³ from ${used.length} dam${used.length === 1 ? '' : 's'} in ${hydroYearLabel(year)}.`;
			onapply(next, status);
			applied = status;
		} catch (e) {
			error = (e as Error).message;
		}
	}
</script>

<h3 id="landuse-dams-h">Farm dams</h3>
{#if dams.length === 0}
	<p class="note">No source lists a dam in this area.</p>
{:else}
	<p>
		Sources are matched by location. A dam’s capacity comes from the register, else Cape Farm Mapper, else its surface area × 3 m. The others stay beside it, and you
		can type your own with a note.
	</p>
	<div class="field">
		<label for="landuse-radius">Same dam within, m</label>
		<input id="landuse-radius" type="number" min="0" step="10" value={radiusM} onchange={(e) => onradius(Number(e.currentTarget.value))} disabled={busy} />
		<span class="note">{DEFAULT_MATCH_RADIUS_M} m by default.</span>
	</div>

	<div class="scroll" use:scrollable>
		<table class="data dams" aria-label="Matched dams">
			<thead>
				<tr>
					<th scope="col">Dam</th>
					<th scope="col" class="num">Capacity used, million m³</th>
					<th scope="col">Source</th>
					<th scope="col">Other sources</th>
					<th scope="col">Your capacity</th>
					<th scope="col">Note</th>
				</tr>
			</thead>
			<tbody>
				{#each used as dam, i (dam.id)}
					{@const failed = problem(dam.id)}
					<tr data-dam={dam.id}>
						<th scope="row">{damName(dams[i]!)}</th>
						<td class="num" data-value="capacity">{dam.capacityMm3 === 0 ? 'none' : formatNumber(dam.capacityMm3, 3)}</td>
						<td>{sourceLabel(dam.source.kind, dam.source.note)}</td>
						<td>
							{#each dam.alternatives ?? [] as other, k (k)}
								<span class="said">{formatNumber(other.capacityMm3, 3)}, {sourceLabel(other.source.kind, other.source.note)}</span>
							{:else}
								<span class="note">none</span>
							{/each}
						</td>
						<td>
							<input
								type="text"
								inputmode="decimal"
								autocomplete="off"
								class="capacity"
								aria-label={`Your capacity for ${damName(dams[i]!)}, million m³`}
								aria-invalid={failed ? 'true' : undefined}
								aria-describedby={failed ? `landuse-dam-${i}-msg` : undefined}
								value={noteOf(dam.id).text}
								oninput={(e) => edit(dam.id, { text: e.currentTarget.value })}
								disabled={busy}
							/>
						</td>
						<td>
							<input
								type="text"
								autocomplete="off"
								aria-label={`Where the figure for ${damName(dams[i]!)} came from`}
								value={noteOf(dam.id).note}
								oninput={(e) => edit(dam.id, { note: e.currentTarget.value })}
								disabled={busy}
							/>
							{#if failed}<span id={`landuse-dam-${i}-msg`} class="error said" role="alert">{failed}</span>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	{#if noFigure.length > 0}
		<p class="warn">
			<strong>{noFigure.length} dam{noFigure.length === 1 ? ' has' : 's have'} no capacity</strong> from any source, or an area too small to measure, so {noFigure.length === 1 ? 'it adds' : 'they add'} nothing to the row. Type a figure if you have one.
		</p>
	{/if}

	{#if choices.length === 0}
		<p class="note">This network has no reservoir, so there is no row to write.</p>
	{:else}
		<div class="field">
			<label for="landuse-reservoir">Farm-dam reservoir</label>
			<select id="landuse-reservoir" value={reservoir?.ref.number} onchange={(e) => (picked = Number(e.currentTarget.value))} disabled={busy}>
				{#each choices as c (c.ref.number)}<option value={c.ref.number}>{c.label}{c.farmDam ? '' : ' (not fed by a single runoff module)'}</option>{/each}
			</select>
		</div>
		<h4>The row</h4>
		<dl class="facts" aria-label="The dams’ row to write">
			<div><dt>Row {year === null ? '' : hydroYearLabel(year)}</dt><dd data-value="dams-mm3">{formatNumber(row.fullSupplyVolumeMm3, 2)} million m³, {formatNumber(row.fullSupplyAreaKm2, 2)} km²</dd></div>
			<div><dt>{before ? 'Replaces' : 'New row'}</dt><dd>{before ? `${formatNumber(before.fullSupplyVolumeMm3, 2)} million m³, ${formatNumber(before.fullSupplyAreaKm2, 2)} km²` : 'none for this year'}</dd></div>
			<div><dt>Dams</dt><dd>{used.length}{unmeasured > 0 ? `, ${unmeasured} with no surface area, taken as capacity ÷ 3 m` : ''}</dd></div>
		</dl>
		{#if row.fullSupplyVolumeMm3 === 0}
			<p class="warn"><strong>No capacity to write.</strong> These dams add up to less than the file’s 0.01 million m³, and a capacity of 0 would take the reservoir out of this year. Type a figure, or keep the row the network has.</p>
		{/if}
		{#if row.fullSupplyVolumeMm3 > 0 && row.fullSupplyAreaKm2 === 0}
			<p class="warn"><strong>Check:</strong> the surface area rounds to 0.00 km² in the file, so the row would have no evaporation.</p>
		{/if}
		{#if blocked.length > 0}<p class="warn" role="status">Finish or clear the {blocked.length === 1 ? 'override' : `${blocked.length} overrides`} above before writing the row.</p>{/if}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<div class="actions">
			<button type="button" class="primary" onclick={apply} disabled={!canApply}>Apply: write the row to RV {reservoir?.ref.number}</button>
		</div>
		{#if applied}
			<div class="applied">
				<p role="status"><strong>Applied.</strong> {applied} The old results were cleared.</p>
				<div class="actions"><button type="button" onclick={onrerun} disabled={busy}>Rerun the network</button></div>
			</div>
		{/if}
	{/if}
{/if}

<style>
	h3 {
		font-size: 1.05rem;
		margin: 1.75rem 0 0.5rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}
	h4 {
		margin: 1.25rem 0 0.25rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
		margin: 0.5rem 0;
	}
	.field select {
		width: 100%;
		max-width: 26rem;
	}
	.field input {
		width: 8rem;
	}
	.dams {
		min-width: 58rem;
	}
	.dams :is(th, td):nth-child(n + 3) {
		text-align: left;
	}
	.dams input {
		width: 100%;
		min-width: 6rem;
	}
	.dams .capacity {
		max-width: 7rem;
	}
	.said {
		display: block;
		font-size: var(--font-sm);
	}
</style>
