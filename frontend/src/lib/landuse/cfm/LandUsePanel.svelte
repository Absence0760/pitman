<!--
	"Land use" (docs/data.md § Cape Farm Mapper, D3, D4): choose a
	(sub-)catchment, fetch its crop fields and dams through the backend, confirm
	how crops map to the irrigation module's crop types, and write the rows. The
	request is the area's geometry alone (rule 7). The map arrives as a snippet,
	as in SubdividePanel.svelte; the client is injected for tests. Applying hands
	the page an updated bundle (`onupdate`), which it stores as the working copy.
-->
<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import { DEFAULT_MATCH_RADIUS_M, matchDams, type AreaGeometry, type LandUseAnswer, type LoadedBundle, type QuaternaryCollection } from '@pitman/wrsm';
	import { MAX_AREA_FILE_BYTES, parseArea } from '#lib/extend/area.js';
	import type { MapProps } from '#lib/map/contract.js';
	import { plural } from '#lib/network/format.js';
	import { formatNumber, hydroYearLabel } from '#lib/results/format.js';
	import { LandUseRequestError, landUseClient, type LandUseClient } from './api.js';
	import CropStep from './CropStep.svelte';
	import DamStep from './DamStep.svelte';
	import { DEFAULT_ROW_YEAR, ROW_YEARS, damMarkers, fieldsShape, validYear } from './plan.js';

	let {
		bundle,
		onupdate,
		busy = false,
		quaternary,
		client = landUseClient,
		map
	}: {
		bundle: LoadedBundle;
		/** The working copy changed: the page replaces its bundle, stores it and says `status`. */
		onupdate: (next: LoadedBundle, status: string) => void;
		/** A run is in progress: no apply until it finishes. */
		busy?: boolean;
		/** The quaternary chosen on the page's map: the starting choice here. */
		quaternary?: string | null;
		client?: LandUseClient;
		/** The page's map, given the props to draw with. */
		map?: Snippet<[MapProps]>;
	} = $props();

	type Loaded = { state: 'loading' } | { state: 'ok'; collection: QuaternaryCollection } | { state: 'failed'; message: string };
	let boundaries = $state.raw<Loaded>({ state: 'loading' });
	const collection = $derived(boundaries.state === 'ok' ? boundaries.collection : null);

	/** A quaternary picked here; the page's map answers until then. */
	let pickedCode = $state<string | undefined>();
	/** A boundary uploaded or drawn: wins over the quaternary until another is picked. */
	let custom = $state.raw<{ label: string; geometry: AreaGeometry } | undefined>();
	let drawing = $state(false);
	let fileError = $state<string | undefined>();

	const code = $derived(pickedCode ?? quaternary ?? '');
	const feature = $derived(collection?.features.find((f) => f.properties.code === code));
	const area = $derived(custom ?? (feature ? { label: `Quaternary ${feature.properties.code}`, geometry: feature.geometry } : undefined));

	let fetchState = $state<'idle' | 'fetching' | 'failed'>('idle');
	let failure = $state.raw<LandUseRequestError | undefined>();
	/** The last answer and the shape it was for: an area changed since shows nothing stale. */
	let fetched = $state.raw<{ geometry: AreaGeometry; answer: LandUseAnswer } | undefined>();
	const answer = $derived(fetched && fetched.geometry === area?.geometry ? fetched.answer : undefined);
	let controller: AbortController | undefined;

	let radiusM = $state<number>(DEFAULT_MATCH_RADIUS_M);
	const dams = $derived(answer ? matchDams(answer.dams, { matchRadiusM: Number.isFinite(radiusM) && radiusM >= 0 ? radiusM : DEFAULT_MATCH_RADIUS_M, fetchedOn: answer.fetchedOn }) : []);

	let typedYear = $state<number | null>(DEFAULT_ROW_YEAR);
	const year = $derived(validYear(typedYear) ? typedYear : null);

	const totalHa = $derived(answer?.fields.reduce((sum, f) => sum + f.areaHa, 0) ?? 0);

	onMount(() => {
		const list = new AbortController();
		client.quaternaries(list.signal).then(
			(result) => (boundaries = { state: 'ok', collection: result }),
			(e: Error) => {
				if (!list.signal.aborted) boundaries = { state: 'failed', message: e.message };
			}
		);
		return () => {
			list.abort();
			controller?.abort();
		};
	});

	function changedArea() {
		controller?.abort();
		fetchState = 'idle';
		failure = undefined;
	}

	function chooseCode(next: string) {
		pickedCode = next;
		custom = undefined;
		drawing = false;
		changedArea();
	}

	function chooseShape(label: string, geometry: AreaGeometry) {
		custom = { label, geometry };
		drawing = false;
		changedArea();
	}

	async function readFile(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		fileError = undefined;
		if (!file) return;
		if (file.size > MAX_AREA_FILE_BYTES) {
			fileError = `${file.name} is larger than ${MAX_AREA_FILE_BYTES / 1024 / 1024} MB.`;
			return;
		}
		let text: string;
		try {
			text = await file.text();
		} catch {
			fileError = `${file.name} could not be read.`;
			return;
		}
		const parsed = parseArea(text);
		if (parsed.ok) chooseShape(file.name, parsed.geometry);
		else fileError = `${file.name}: ${parsed.error}`;
	}

	async function fetchData() {
		if (!area) return;
		const { geometry } = area;
		controller?.abort();
		const mine = new AbortController();
		controller = mine;
		fetchState = 'fetching';
		failure = undefined;
		try {
			const result = await client.landUse(geometry, mine.signal);
			if (mine.signal.aborted) return;
			fetched = { geometry, answer: result };
			fetchState = 'idle';
			await tick();
			document.getElementById('landuse-result-h')?.focus();
		} catch (e) {
			if (mine.signal.aborted) return;
			failure = e instanceof LandUseRequestError ? e : new LandUseRequestError('server', 'The land-use service failed. Try again later.');
			fetchState = 'failed';
		}
	}

	function cancel() {
		controller?.abort();
		fetchState = 'idle';
	}

	const mapProps = $derived<MapProps>({
		quaternaries: collection,
		selected: custom ? null : code || null,
		modules: damMarkers(dams),
		proposal: fieldsShape(answer?.fields ?? []) ?? custom?.geometry ?? null,
		tool: drawing ? 'draw' : 'select',
		onselect: chooseCode,
		ondraw: (geometry) => chooseShape('The boundary you drew', geometry)
	});
</script>

<section aria-labelledby="landuse-h" class="card">
	<h2 id="landuse-h">Land use</h2>
	<p>
		Bring irrigated areas and farm dams up to date: fetch the crop census and the dams for a catchment or a piece of one, confirm how the crops map to the irrigation
		module, and write each row. Only the area’s shape is sent, never the network’s files.
	</p>

	<div class="work" class:with-map={map !== undefined}>
		{#if map}
			<div class="map-slot" data-map-tool={drawing ? 'draw' : 'select'}>{@render map(mapProps)}</div>
		{/if}
		<div class="flow">
			<h3 id="landuse-area-h">The area</h3>
			{#if boundaries.state === 'ok'}
				<div class="field">
					<label for="landuse-quaternary">Quaternary</label>
					<select id="landuse-quaternary" value={custom ? '' : code} onchange={(e) => chooseCode(e.currentTarget.value)} disabled={fetchState === 'fetching'}>
						<option value="">Choose…</option>
						{#each boundaries.collection.features as f (f.properties.code)}<option value={f.properties.code}>{f.properties.code}</option>{/each}
					</select>
					<span class="note">{boundaries.collection.source}</span>
				</div>
			{:else if boundaries.state === 'failed'}
				<p class="note">The list of quaternaries isn’t available here ({boundaries.message}). Upload a boundary instead.</p>
			{:else}
				<p class="note">Loading the quaternaries…</p>
			{/if}

			<div class="field">
				<input id="landuse-file" class="file-pick" type="file" accept=".geojson,.json,application/geo+json,application/json" aria-invalid={fileError ? 'true' : undefined} aria-describedby={fileError ? 'landuse-file-error' : undefined} onchange={readFile} disabled={fetchState === 'fetching'} />
				<label for="landuse-file">Or upload a boundary (GeoJSON)</label>
			</div>
			{#if map}
				<div class="actions">
					<button type="button" aria-pressed={drawing} onclick={() => (drawing = !drawing)} disabled={fetchState === 'fetching'}>{drawing ? 'Stop drawing' : 'Or draw one on the map'}</button>
				</div>
			{/if}
			{#if fileError}<p id="landuse-file-error" class="error" role="alert">{fileError}</p>{/if}

			{#if area}
				<p>Area: <strong>{area.label}</strong></p>
				<div class="actions">
					<button type="button" class="primary" onclick={fetchData} disabled={fetchState === 'fetching'}>{answer ? 'Fetch again' : 'Fetch the fields and dams'}</button>
					{#if fetchState === 'fetching'}
						<button type="button" onclick={cancel}>Cancel</button>
						<p class="note" role="status">Fetching…</p>
					{/if}
				</div>
			{/if}

			{#if failure?.kind === 'unavailable'}
				<div class="warn" role="alert">
					<p><strong>The land-use data isn’t available.</strong> The service says: {failure.message}</p>
					<p>
						Cape Farm Mapper needs a token that only the operator can supply, so a server without one can’t fetch fields or dams. The network’s own irrigation and
						dam rows stay as they are, and everything else in Pitman works. Running Pitman locally, set <code>CFM_SOURCE=local</code> in
						<code>backend/.env.development</code> for invented data to try this screen with.
					</p>
				</div>
			{:else if failure}
				<p class="error" role="alert">{failure.message}</p>
			{/if}
		</div>
	</div>

	{#if answer}
		<h3 id="landuse-result-h" tabindex="-1">What came back</h3>
		{#if answer.source === 'local'}
			<p class="warn" data-synthetic><strong>Synthetic data.</strong> These fields and dams are invented for local development, not Cape Farm Mapper’s. Don’t use a row from them in a study.</p>
		{/if}
		{#each answer.warnings ?? [] as warning (warning)}
			<p class="warn"><strong>Check:</strong> {warning}</p>
		{/each}
		<dl class="facts provenance" aria-label="Where the land-use data came from">
			<div><dt>Dataset</dt><dd data-value="dataset">{answer.dataset}</dd></div>
			<div><dt>Census year</dt><dd>{answer.surveyYear}</dd></div>
			<div><dt>Fetched</dt><dd>{answer.fetchedOn}</dd></div>
			<div><dt>Found</dt><dd data-value="found">{plural(answer.fields.length, 'field')}, {formatNumber(totalHa, 1)} ha; {plural(dams.length, 'dam')}</dd></div>
		</dl>

		<div class="field">
			<label for="landuse-year">Year of the rows</label>
			<input id="landuse-year" type="number" min={ROW_YEARS.from} max={ROW_YEARS.to} step="1" bind:value={typedYear} aria-invalid={year === null ? 'true' : undefined} aria-describedby="landuse-year-hint" disabled={busy} />
			<span id="landuse-year-hint" class="note">
				{#if year === null}
					Type a year from {ROW_YEARS.from} to {ROW_YEARS.to}.
				{:else if year !== answer.surveyYear}
					Hydrological year {hydroYearLabel(year)}. The census describes {answer.surveyYear}, so the row says that picture still holds in {year}.
				{:else}
					Hydrological year {hydroYearLabel(year)}, the census’s own.
				{/if}
			</span>
		</div>

		{#key answer}
			<CropStep {bundle} {answer} {year} {busy} onapply={onupdate} />
			<DamStep {bundle} {dams} {radiusM} {year} {busy} onradius={(m) => (radiusM = m)} onapply={onupdate} />
		{/key}
	{/if}
</section>

<style>
	.work {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
	}
	.map-slot {
		position: relative;
		height: 20rem;
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		background: var(--surface-2);
	}
	.flow {
		min-width: 0;
	}
	@media (min-width: 75rem) {
		.work.with-map {
			grid-template-columns: minmax(0, 1fr) minmax(20rem, 50%);
			gap: 1.5rem;
			align-items: start;
		}
		.work.with-map .flow {
			grid-column: 1;
			grid-row: 1;
		}
		.work.with-map .map-slot {
			grid-column: 2;
			grid-row: 1;
			height: 24rem;
		}
	}
	h3 {
		font-size: 1.05rem;
		margin: 1.75rem 0 0.5rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
		scroll-margin-top: calc(var(--bar-h) + 1rem);
	}
	.flow > h3:first-child {
		margin-top: 0;
		padding-top: 0;
		border-top: 0;
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
	#landuse-year {
		width: 8rem;
	}
</style>
