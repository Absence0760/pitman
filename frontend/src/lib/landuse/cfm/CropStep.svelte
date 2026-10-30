<!--
	The fields by crop, the crop mapping and the irrigation module's row
	(docs/data.md § Cape Farm Mapper, D-8). The panel keys this on the answer,
	so a new fetch starts it afresh.
-->
<script lang="ts">
	import { applyIrrigatedAreas, irrigatedRowKm2, sumIrrigatedAreas, type LandUseAnswer, type LoadedBundle } from '@pitman/wrsm';
	import { formatNumber, hydroYearLabel } from '#lib/results/format.js';
	import { confirmedMapping, countedHa, cropRows, irrigationChoices, startingChoice, undecidedCrops, type CropChoice } from './plan.js';

	let {
		bundle,
		answer,
		year,
		busy = false,
		onapply,
		onrerun
	}: {
		bundle: LoadedBundle;
		answer: LandUseAnswer;
		/** The row's year; `null` while what is typed isn't one. */
		year: number | null;
		busy?: boolean;
		onapply: (next: LoadedBundle, status: string) => void;
		onrerun: () => void;
	} = $props();

	const rows = $derived(cropRows(answer.fields));
	const choices = $derived(irrigationChoices(bundle));
	let picked = $state<number | undefined>();
	const module = $derived(choices.find((c) => c.ref.number === picked) ?? choices.find((c) => !c.refused) ?? choices[0]);
	let chosen = $state.raw<ReadonlyMap<string, CropChoice>>(new Map());
	let marked = $state.raw<ReadonlySet<string>>(new Set());
	let error = $state<string | undefined>();
	let applied = $state<string | undefined>();

	const choiceOf = (crop: string): CropChoice => (chosen.has(crop) ? chosen.get(crop) : startingChoice(crop, module?.types ?? [], bundle.sidecar?.capeFarmMapper?.cropMapping));
	const undecided = $derived(undecidedCrops(rows, choiceOf, marked));
	const mapping = $derived(confirmedMapping(rows, choiceOf, marked));
	const areas = $derived(undecided.length === 0 ? sumIrrigatedAreas(answer.fields, mapping, [...marked]) : []);
	const rowKm2 = $derived(irrigatedRowKm2(areas));
	const exactKm2 = $derived(areas.reduce((sum, a) => sum + a.areaKm2, 0));
	const before = $derived(year === null ? undefined : module?.rows.find((r) => r.year === year));
	const canApply = $derived(module !== undefined && !module.refused && year !== null && undecided.length === 0 && areas.length > 0 && !busy);

	function chooseModule(event: Event & { currentTarget: HTMLSelectElement }) {
		picked = Number(event.currentTarget.value);
		// Another module has other crop types.
		chosen = new Map();
		error = undefined;
		applied = undefined;
	}

	function chooseCrop(crop: string, value: string) {
		const next = value === '' ? undefined : value === 'leave' ? null : module?.types[Number(value)];
		chosen = new Map(chosen).set(crop, next);
	}

	function mark(crop: string, on: boolean) {
		const next = new Set(marked);
		if (on) next.add(crop);
		else next.delete(crop);
		marked = next;
	}

	const selectValue = (choice: CropChoice) => (choice === undefined ? '' : choice === null ? 'leave' : String(module?.types.indexOf(choice) ?? ''));

	function apply() {
		if (!canApply || !module || year === null) return;
		error = undefined;
		try {
			const next = applyIrrigatedAreas(bundle, module.ref, year, areas, { kind: 'capeFarmMapper', note: answer.dataset, date: answer.fetchedOn }, mapping);
			const status = `RR ${module.ref.number}: ${formatNumber(rowKm2, 2)} km² irrigated in ${hydroYearLabel(year)}.`;
			onapply(next, status);
			applied = status;
		} catch (e) {
			error = (e as Error).message;
		}
	}
</script>

<h3 id="landuse-crops-h">Irrigated fields</h3>
{#if rows.length === 0}
	<p class="note">The census has no fields in this area.</p>
{:else}
	<p>
		The layer’s word on irrigation stands where it has one. Where it says nothing, tick the crops that are irrigated. Map each irrigated crop to one of the module’s
		crop types: Pitman offers a match only when there is no doubt.
	</p>

	{#if choices.length === 0}
		<p class="note">This network has no irrigation module, so there is no row to write.</p>
	{:else}
		<div class="field">
			<label for="landuse-module">Irrigation module</label>
			<select id="landuse-module" value={module?.ref.number} onchange={chooseModule} disabled={busy}>
				{#each choices as c (c.ref.number)}<option value={c.ref.number}>{c.label}</option>{/each}
			</select>
		</div>
		{#if module?.refused}<p class="warn">{module.refused}</p>{/if}
	{/if}

	<div class="scroll">
		<table class="data crops" aria-label="Fields by crop">
			<thead>
				<tr>
					<th scope="col">Crop</th>
					<th scope="col" class="num">Fields</th>
					<th scope="col" class="num">Area, ha</th>
					<th scope="col">The layer says</th>
					<th scope="col">Irrigated</th>
					<th scope="col" class="num">Counted, ha</th>
					<th scope="col">Crop type</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.crop)}
					{@const choice = choiceOf(row.crop)}
					{@const counted = countedHa(row, marked.has(row.crop))}
					<tr data-crop={row.crop}>
						<th scope="row">{row.crop}</th>
						<td class="num">{row.fields}</td>
						<td class="num">{formatNumber(row.totalHa, 1)}</td>
						<td>
							{#if row.irrigatedHa > 0}<span class="said">{formatNumber(row.irrigatedHa, 1)} irrigated</span>{/if}
							{#if row.dryHa > 0}<span class="said">{formatNumber(row.dryHa, 1)} dryland</span>{/if}
							{#if row.unknownHa > 0}<span class="said">{formatNumber(row.unknownHa, 1)} doesn’t say</span>{/if}
						</td>
						<td>
							{#if row.unknownHa > 0}
								<label class="tick">
									<input type="checkbox" checked={marked.has(row.crop)} onchange={(e) => mark(row.crop, e.currentTarget.checked)} disabled={busy} />
									<span class="sr">{row.crop} is irrigated</span>
								</label>
							{:else}
								<span class="note">as the layer says</span>
							{/if}
						</td>
						<td class="num">{formatNumber(counted, 1)}</td>
						<td>
							{#if counted > 0}
								<select
									aria-label={`Crop type for ${row.crop}`}
									aria-invalid={choice === undefined ? 'true' : undefined}
									value={selectValue(choice)}
									onchange={(e) => chooseCrop(row.crop, e.currentTarget.value)}
									disabled={busy || !module}
								>
									<option value="">Choose…</option>
									{#each module?.types ?? [] as type, i (i)}<option value={String(i)}>{type}</option>{/each}
									<option value="leave">Leave out</option>
								</select>
							{:else}
								<span class="note">not counted</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	{#if undecided.length > 0}
		<p class="warn" role="status"><strong>Choose a crop type</strong> for {undecided.join(', ')}, or leave {undecided.length === 1 ? 'it' : 'them'} out.</p>
	{/if}

	{#if module && !module.refused}
		<h4>The row</h4>
		{#if areas.length > 0}
			<div class="scroll">
				<table class="data preview" aria-label="Irrigated area by crop type">
					<thead><tr><th scope="col">Crop type</th><th scope="col" class="num">Area, km²</th><th scope="col" class="num">Share, %</th></tr></thead>
					<tbody>
						{#each areas as a (a.crop)}
							<tr><th scope="row">{a.crop}</th><td class="num">{formatNumber(a.areaKm2, 3)}</td><td class="num">{formatNumber((a.areaKm2 / exactKm2) * 100, 1)}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
			<dl class="facts" aria-label="The row to write">
				<div><dt>Row {year === null ? '' : hydroYearLabel(year)}</dt><dd data-value="irrigated-km2">{formatNumber(rowKm2, 2)} km²</dd></div>
				<div><dt>{before ? 'Replaces' : 'New row'}</dt><dd>{before ? `${formatNumber(before.value, 2)} km²` : 'none for this year'}</dd></div>
				{#if module.rows.length > 0}
					{@const last = module.rows.at(-1)}
					<div><dt>Last row in the module</dt><dd>{last ? `${formatNumber(last.value, 2)} km² in ${hydroYearLabel(last.year)}` : '—'}</dd></div>
				{/if}
			</dl>
			{#if module.types.length > 1}
				<p class="note">The module holds one crop mix for every year, so applying sets its percentages to these shares. The sidecar keeps what they were.</p>
			{/if}
			{#if rowKm2 === 0}
				<p class="warn"><strong>Check:</strong> {formatNumber(exactKm2, 4)} km² rounds to 0.00 in the file, which holds two decimals.</p>
			{/if}
		{:else if undecided.length === 0}
			<p class="note">Nothing is counted as irrigated yet: tick a crop above.</p>
		{/if}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<div class="actions">
			<button type="button" class="primary" onclick={apply} disabled={!canApply}>Apply: write the row to RR {module.ref.number}</button>
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
	.crops {
		min-width: 52rem;
	}
	.crops :is(th, td):nth-child(4),
	.crops :is(th, td):nth-child(5),
	.crops :is(th, td):nth-child(7) {
		text-align: left;
	}
	.crops select {
		min-width: 9rem;
	}
	.preview {
		min-width: 18rem;
		max-width: 30rem;
	}
	.said {
		display: block;
		white-space: nowrap;
	}
	.tick {
		display: inline-flex;
		align-items: center;
		min-height: var(--control-h);
	}
</style>
