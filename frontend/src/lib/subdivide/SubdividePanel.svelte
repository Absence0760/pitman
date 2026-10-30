<!--
	"Sub-divide a quaternary" (method B, docs/theory/subdivide.md): one screen
	flowing down the page, as the extension does. Pick the quaternary and its
	runoff module, split it (a tributary or a MAP zone, up to 8 pieces), review
	the pieces, calibrate their MAPs, apply, rerun. Logic is in the .ts modules
	beside this file (tested there); this component holds the state.

	The map and the tributary tool arrive as snippets, the engine and the
	backend as props, so the panel compiles and tests alone. Applying hands the
	page an updated bundle (`onupdate`), as ExtendPanel does; the page clears
	its results then, so the panel keeps the runs from before for the compare.
-->
<script lang="ts">
	import { scrollable } from '#lib/shell/scrollable.js';
	import { onMount, tick, untrack, type Snippet } from 'svelte';
	import type { AreaGeometry, ChannelCollection, MapGridCells, RunResult, SplitPreview, SplitRecord } from '@pitman/wrsm';
	import { API_BASE_URL } from '#lib/extend/api-base.js';
	import type { MapProps, MapTool } from '#lib/map/contract.js';
	import ZoneTool from '#lib/map/mapzone/ZoneTool.svelte';
	import type { LoadedBundle } from '#lib/network/engine.js';
	import { plural } from '#lib/network/format.js';
	import { formatNumber } from '#lib/results/format.js';
	import CalibrateStep from './CalibrateStep.svelte';
	import { applyOptions, mayApply, outcomeSentence, type CalibrationOutcome } from './calibration.js';
	import { SubdivideRequestError, createSubdivideData, type SubdivideData } from './data.js';
	import { subdivideEngine, type SubdivideEngine } from './engine.js';
	import { bboxOf, centreOf, geometryAreaKm2, type Bbox } from './geometry.js';
	import { choicesFor, doneRows, featureOf, runoffChoices, splitBlock, type Loaded, type Upload } from './modules.js';
	import OutletCompare from './OutletCompare.svelte';
	import { outletRoute } from './outlet.js';
	import PieceCards from './PieceCards.svelte';
	import {
		MAX_PIECES,
		buildPlan,
		damsByPiece,
		mapPieces,
		pieceBlockers,
		pieceRows,
		planShares,
		roleLabel,
		shareLines,
		splitLabel,
		splitPiece,
		startPieces,
		tributarySplit,
		undoTo,
		zoneSplit,
		type Piece,
		type PieceSet,
		type RowInput,
		type SampleState,
		type SplitResult
	} from './pieces.js';
	import QuaternaryPick from './QuaternaryPick.svelte';
	import type { TributarySlot } from './slots.js';
	import { stepId, wizardSteps, type WizardInput } from './steps.js';
	import { crossCheckOf, resolveTarget, type UnsplitNatural } from './target.js';

	let {
		bundle,
		onupdate,
		onrerun,
		busy = false,
		runs = [],
		quaternary: pickedOnMap,
		engine = subdivideEngine,
		data = createSubdivideData({ baseUrl: API_BASE_URL }),
		map,
		tributary
	}: {
		bundle: LoadedBundle;
		/** The working copy changed: the page replaces its bundle, stores it and says `status`. */
		onupdate: (next: LoadedBundle, status: string) => void;
		/** Run the network again (the page's Run, with the modes chosen there). */
		onrerun: () => void;
		/** A run is in progress: no apply until it finishes. */
		busy?: boolean;
		/** The page's current results: what the before/after compares. */
		runs?: readonly RunResult[];
		/** The quaternary chosen on the page's map: the starting choice here. */
		quaternary?: string | undefined;
		engine?: SubdivideEngine;
		data?: SubdivideData;
		/** The page's map, given the props to draw with. */
		map?: Snippet<[MapProps]>;
		/** The tributary tool (agent 5.2); without it the screen says so and MAP zones still work. */
		tributary?: Snippet<[TributarySlot]>;
	} = $props();

	type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

	/** The engine says why in a sentence; the screen shows it instead of breaking. */
	function attempt<T>(run: () => T): Attempt<T> {
		try {
			return { ok: true, value: run() };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	}

	// Step 1
	let loaded = $state.raw<Loaded>({ state: 'loading' });
	let code = $state('');
	let moduleNumber = $state<number | undefined>();
	let upload = $state.raw<Upload | undefined>();
	let controller = new AbortController();
	const collection = $derived(loaded.state === 'ok' ? loaded.collection : undefined);
	const choices = $derived(runoffChoices(bundle));
	const module = $derived(choices.find((c) => c.ref.number === moduleNumber));
	const quaternary = $derived.by(() => {
		if (upload) return { code: upload.code, geometry: upload.geometry, source: `your file ${upload.fileName}` };
		const feature = collection && code ? featureOf(collection, code) : undefined;
		return feature && collection ? { code, geometry: feature.geometry, source: collection.source } : undefined;
	});
	const boundaryKm2 = $derived(quaternary ? geometryAreaKm2(quaternary.geometry) : undefined);
	const block = $derived(module ? splitBlock(bundle, module.ref, quaternary?.code) : null);
	const earlyCheck = $derived(module && boundaryKm2 !== undefined ? attempt(() => engine.scalePieceAreas(module.areaKm2, [boundaryKm2])) : undefined);

	// The steps
	let stage = $state(1);
	let announcement = $state('');
	let confirmRestart = $state(false);

	// Step 2
	let set = $state.raw<PieceSet | undefined>();
	let past = $state.raw<readonly PieceSet[]>([]);
	let splitting = $state(false);
	let kind = $state<'tributary' | 'zone'>('tributary');
	let targetIndex = $state(0);
	let zoneTool = $state<MapTool>('select');
	const tool = $derived<MapTool>(!splitting ? 'select' : kind === 'tributary' ? 'point' : zoneTool);
	let proposal = $state.raw<AreaGeometry | null>(null);
	let gridLayer = $state.raw<MapGridCells | null>(null);
	let channels = $state.raw<ChannelCollection | null>(null);
	let drawn = $state.raw<AreaGeometry | null>(null);
	let click = $state.raw<readonly [number, number] | null>(null);
	let view = $state.raw<Bbox | null>(null);
	const target = $derived(set?.pieces[targetIndex]);
	const targetLabel = $derived(target ? pieceName(target, targetIndex) : '');

	// Step 3
	let samples = $state.raw<Readonly<Record<string, SampleState>>>({});
	let typed = $state.raw<Readonly<Record<string, string>>>({});
	let showBlockers = $state(false);
	const dams = $derived(set ? damsByPiece(bundle.sidecar?.dams ?? [], set.pieces) : []);
	const shares = $derived(planShares(dams));
	const areas = $derived(set && module && set.pieces.length > 1 ? attempt(() => engine.scalePieceAreas(module.areaKm2, set?.pieces.map((p) => p.polygonKm2) ?? [])) : undefined);
	const rowInput = $derived<RowInput | undefined>(set ? { set, samples, typed, areas: areas?.ok ? areas.value : undefined, dams, preview: undefined } : undefined);
	const plan = $derived.by(() => {
		if (!set || !rowInput || !module || !quaternary) return null;
		return buildPlan(quaternary.code, module.ref, set, pieceRows(rowInput, module.ref), shares, dams);
	});
	const preview = $derived.by((): Attempt<SplitPreview> | undefined => {
		const planned = plan;
		return planned ? attempt(() => engine.previewSplit(bundle, planned)) : undefined;
	});
	const rows = $derived(rowInput && module ? pieceRows({ ...rowInput, preview: preview?.ok ? preview.value : undefined }, module.ref) : []);
	const blockers = $derived(pieceBlockers(rows));

	// Step 4
	let unsplit = $state.raw<UnsplitNatural | undefined>();
	let unsplitError = $state<string | undefined>();
	let marText = $state('');
	let citation = $state('');
	let targetError = $state<{ field: 'mar' | 'citation'; text: string } | undefined>();
	let calibrating = $state(false);
	let calibrationError = $state<string | undefined>();
	let outcome = $state.raw<CalibrationOutcome | undefined>();
	let outcomeFor = $state.raw<{ bundle: LoadedBundle; marText: string; citation: string } | undefined>();
	const stale = $derived(outcome !== undefined && (outcomeFor?.bundle !== bundle || outcomeFor.marText !== marText || outcomeFor.citation !== citation));
	const calibrationState = $derived.by((): WizardInput['calibration'] => {
		if (!outcome) return 'none';
		if (stale) return 'stale';
		if (outcome.result.status === 'converged') return 'converged';
		if (outcome.result.status === 'refused') return 'refused';
		return outcome.acceptNotConverged ? 'accepted' : 'not_converged';
	});

	// Step 5
	let applyError = $state<string | undefined>();
	let applied = $state.raw<{ summary: string; before: readonly RunResult[]; route: number | undefined; notConverged: boolean } | undefined>();
	const showApply = $derived(stage >= 5 && mayApply(outcome) && !stale);

	const steps = $derived(
		wizardSteps({
			stage: showApply ? 5 : Math.min(stage, 4),
			choice: quaternary && module ? `${quaternary.code}, ${module.ref.type} ${module.ref.number}` : undefined,
			pieces: set?.pieces.length ?? 0,
			problems: blockers.length,
			calibration: calibrationState
		})
	);
	const done = $derived(doneRows(bundle));

	const mapProps = $derived<MapProps>({
		quaternaries: collection ?? null,
		selected: quaternary?.code ?? null,
		modules: collection
			? choices.flatMap((c) => {
					const feature = c.quaternary ? featureOf(collection, c.quaternary) : undefined;
					return feature ? [{ id: `RU${c.ref.number}`, label: c.label, lngLat: centreOf(feature.geometry) }] : [];
				})
			: [],
		pieces: set ? mapPieces(set) : [],
		channels,
		mapGrid: gridLayer,
		proposal: proposal ?? (stage === 1 ? (upload?.geometry ?? null) : null),
		tool,
		onselect: (next) => {
			if (stage === 1) chooseQuaternary(next);
		},
		onpoint: (lngLat) => {
			click = lngLat;
		},
		ondraw: (geometry) => {
			drawn = geometry;
		},
		onview: (bbox) => {
			view = bbox;
		}
	});

	function pieceName(piece: Piece, index: number): string {
		return (set?.pieces.length ?? 1) === 1 ? 'the quaternary' : `piece ${index + 1} (${roleLabel(piece.role).toLowerCase()})`;
	}

	async function focusById(id: string) {
		await tick();
		document.getElementById(id)?.focus();
	}

	const focusStep = (n: number) => focusById(stepId(n));

	async function loadQuaternaries() {
		loaded = { state: 'loading' };
		const signal = controller.signal;
		try {
			const collection = await data.quaternaries(signal);
			if (!signal.aborted) loaded = { state: 'ok', collection };
		} catch (error) {
			if ((error as Error).name !== 'AbortError') loaded = { state: 'failed', message: (error as Error).message };
		}
	}

	onMount(() => {
		void loadQuaternaries();
		return () => controller.abort();
	});

	// The page's map answers the same question first: follow what is picked there through step 1, never over a choice made here.
	let followedMap: string | undefined;
	$effect(() => {
		const picked = pickedOnMap;
		const collection = loaded.state === 'ok' ? loaded.collection : undefined;
		if (!picked || !collection || featureOf(collection, picked) === undefined) return;
		untrack(() => {
			if (code !== '' && !(stage === 1 && code === followedMap)) return;
			followedMap = picked;
			chooseQuaternary(picked);
		});
	});

	function chooseQuaternary(next: string) {
		// A quaternary picked from the list or the map replaces an uploaded boundary, which would otherwise win.
		if (upload && upload.code !== next) upload = undefined;
		code = next;
		const { named } = choicesFor(choices, next);
		if (named.length === 1) moduleNumber = named[0]?.ref.number;
		else if (module?.quaternary !== next) moduleNumber = undefined;
	}

	function chooseUpload(next: Upload | undefined) {
		upload = next;
		if (next) chooseQuaternary(next.code);
	}

	function clearTool() {
		zoneTool = 'select';
		proposal = null;
		gridLayer = null;
		channels = null;
		drawn = null;
		click = null;
	}

	/** Anything that changes the pieces makes a calibration meaningless. */
	function invalidate() {
		outcome = undefined;
		outcomeFor = undefined;
		calibrationError = undefined;
		applyError = undefined;
		if (stage > 3) stage = 3;
	}

	function begin() {
		if (!quaternary || !module || block || boundaryKm2 === undefined) return;
		set = startPieces(quaternary.geometry, boundaryKm2);
		past = [];
		splitting = true;
		kind = tributary ? 'tributary' : 'zone';
		targetIndex = 0;
		stage = 2;
		void focusStep(2);
	}

	function restart() {
		controller.abort();
		controller = new AbortController();
		if (loaded.state === 'loading') void loadQuaternaries();
		// The pick step remounts with its file and code empty, so nothing may still rest on them.
		upload = undefined;
		set = undefined;
		past = [];
		splitting = false;
		samples = {};
		typed = {};
		showBlockers = false;
		unsplit = undefined;
		unsplitError = undefined;
		marText = '';
		citation = '';
		targetError = undefined;
		confirmRestart = false;
		clearTool();
		invalidate();
		stage = 1;
	}

	async function startAgain() {
		restart();
		await focusById(moduleNumber === undefined ? 'subdivide-module' : 'subdivide-continue');
	}

	function askRestart() {
		if ((set?.splits.length ?? 0) === 0) return startAgain();
		confirmRestart = true;
		return focusById('subdivide-keep');
	}

	function keepSplits() {
		confirmRestart = false;
		return focusById('subdivide-restart');
	}

	async function readSample(piece: Piece) {
		const { signal } = controller;
		samples = { ...samples, [piece.id]: { state: 'loading' } };
		try {
			const sample = await data.mapGridMean(piece.geometry, signal);
			if (!signal.aborted) samples = { ...samples, [piece.id]: { state: 'ok', sample } };
		} catch (error) {
			if ((error as Error).name === 'AbortError') return;
			const notCovered = error instanceof SubdivideRequestError && error.status === 422;
			samples = { ...samples, [piece.id]: { state: 'failed', message: (error as Error).message, notCovered } };
		}
	}

	function accept(split: SplitResult) {
		if (!set) return;
		const result = attempt(() => splitPiece(set as PieceSet, targetIndex, split));
		if (!result.ok) {
			announcement = result.error;
			return;
		}
		past = [...past, set];
		set = result.value;
		splitting = false;
		clearTool();
		invalidate();
		stage = 3;
		showBlockers = false;
		for (const piece of result.value.pieces) if (samples[piece.id] === undefined) void readSample(piece);
		announcement = `${result.value.pieces.length} pieces.`;
		void focusStep(3);
	}

	function acceptZone(zone: ReturnType<SubdivideEngine['splitByZone']>, record: SplitRecord) {
		accept(zoneSplit(zone, record));
	}

	function acceptTributary(answer: Parameters<TributarySlot['onaccept']>[0], at: readonly [number, number]) {
		accept(tributarySplit(answer, at));
	}

	function splitAgain() {
		targetIndex = 0;
		splitting = true;
		clearTool();
		void focusStep(2);
	}

	function keepPieces() {
		splitting = false;
		clearTool();
		void focusStep(3);
	}

	function undo() {
		const previous = past[past.length - 1];
		if (!previous || !set) return;
		set = undoTo(previous, set);
		past = past.slice(0, -1);
		showBlockers = false;
		invalidate();
		if (previous.pieces.length < 2) {
			splitting = true;
			targetIndex = 0;
			stage = 2;
			void focusStep(2);
		} else {
			announcement = `Undone: ${previous.pieces.length} pieces.`;
			void focusStep(3);
		}
	}

	function typeMap(id: string, text: string) {
		typed = { ...typed, [id]: text };
		invalidate();
	}

	function retry(id: string) {
		const piece = set?.pieces.find((p) => p.id === id);
		if (piece) void readSample(piece);
	}

	function readUnsplit() {
		if (!module) return;
		const ref = module.ref;
		const result = attempt(() => engine.unsplitNaturalMar(bundle, ref));
		unsplit = result.ok ? result.value : undefined;
		unsplitError = result.ok ? undefined : result.error;
	}

	// A plan the engine would refuse stops here, before a calibration that could never be applied.
	const refusal = $derived(preview?.ok ? preview.value.refused : undefined);

	function toCalibrate() {
		if (refusal) {
			void focusById('subdivide-refused');
			return;
		}
		if (blockers.length > 0 || !plan) {
			showBlockers = true;
			const first = rows[(blockers[0]?.number ?? 1) - 1];
			if (first) void focusById(`${first.id}-map`);
			return;
		}
		readUnsplit();
		stage = 4;
		void focusStep(4);
	}

	async function calibrate() {
		readUnsplit();
		if (!plan || !unsplit || refusal) return;
		const resolved = resolveTarget(marText, citation, unsplit);
		if (!resolved.ok) {
			targetError = { field: resolved.field, text: resolved.error };
			void focusById(resolved.field === 'mar' ? 'subdivide-mar' : 'subdivide-citation');
			return;
		}
		targetError = undefined;
		calibrationError = undefined;
		calibrating = true;
		outcome = undefined;
		if (stage > 4) stage = 4;
		// The loop runs on this thread: let the "running" line paint first.
		await tick();
		await new Promise((resolve) => setTimeout(resolve));
		const planned = plan;
		const result = attempt(() => engine.calibrateMap(bundle, planned, resolved.target));
		calibrating = false;
		if (!result.ok) {
			calibrationError = result.error;
			return;
		}
		outcome = { result: result.value, target: resolved.target, crossCheck: crossCheckOf(unsplit), acceptNotConverged: false };
		outcomeFor = { bundle, marText, citation };
		void focusById('subdivide-calibration-result');
	}

	function useBest() {
		if (!outcome || outcome.result.best === null) return;
		outcome = { ...outcome, acceptNotConverged: true };
		stage = 5;
		void focusStep(5);
	}

	function changeTarget() {
		void focusById('subdivide-mar');
	}

	function cancelCalibration() {
		invalidate();
		announcement = 'Calibration cancelled. Nothing was applied.';
		void focusStep(3);
	}

	function toApply() {
		stage = 5;
		void focusStep(5);
	}

	async function apply() {
		applyError = undefined;
		if (!plan || !outcome || !module || !quaternary || !mayApply(outcome) || stale || busy) return;
		const planned = plan;
		const options = applyOptions(outcome);
		const result = attempt(() => engine.applySplit(bundle, planned, options));
		if (!result.ok) {
			applyError = result.error;
			void focusById('subdivide-apply-error');
			return;
		}
		const names = preview?.ok ? preview.value.pieces.map((p) => `${p.module.type} ${p.module.number}`).join(', ') : `${planned.pieces.length} modules`;
		const summary = `${quaternary.code}: ${module.ref.type} ${module.ref.number} is now ${planned.pieces.length} runoff modules (${names}).`;
		applied = { summary, before: runs, route: outletRoute(bundle, module.ref), notConverged: outcome.result.status !== 'converged' };
		onupdate(result.value, summary);
		restart();
		code = '';
		moduleNumber = undefined;
		upload = undefined;
		await focusById('subdivide-applied');
	}

	const STATE_WORDS = { done: 'Done', current: 'Now', todo: 'To do' } as const;
</script>

<section aria-labelledby="subdivide-h" class="card" data-stage={stage}>
	<h2 id="subdivide-h">Sub-divide a quaternary</h2>
	<p>
		Give part of a quaternary its own runoff module: a tributary’s catchment, or a high- or low-rainfall area. Each piece gets its own area and MAP; every piece keeps the
		quaternary’s rainfall file and parameters. You review the pieces and calibrate their MAPs before anything changes in the network (docs: method B).
	</p>

	{#if done.length > 0}
		<div class="scroll" use:scrollable>
			<table class="done" aria-label="Quaternaries already sub-divided">
				<thead>
					<tr><th scope="col">Quaternary</th><th scope="col">Module split</th><th scope="col">Pieces</th><th scope="col">Target natural MAR</th><th scope="col">Calibration</th></tr>
				</thead>
				<tbody>
					{#each done as row, i (i)}
						<tr><th scope="row">{row.quaternary}</th><td>{row.original}</td><td>{row.pieces}</td><td>{row.target}</td><td>{row.status}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if applied}
		<div class="applied" id="subdivide-applied" tabindex="-1">
			<p role="status"><strong>Applied.</strong> {applied.summary}</p>
			{#if applied.notConverged}
				<p class="warn"><strong>Recorded as not converged:</strong> the best factor was used, and <code>pitman.json</code> says so.</p>
			{/if}
			<p>Everything is in this browser’s working copy and in <code>pitman.json</code>; save the zip to keep it. Rerun the network to see results with the new modules.</p>
			<div class="actions">
				<button type="button" class="primary" onclick={onrerun} disabled={busy}>Rerun the network</button>
			</div>
			{#if applied.before.length === 0}
				<p class="note">There were no results from before the split, so no before and after to show.</p>
			{:else if runs.length === 0}
				<p class="note">The results from before the split are kept here. Rerun to compare them.</p>
			{:else}
				<OutletCompare {bundle} before={applied.before} after={runs} initialRoute={applied.route} />
			{/if}
		</div>
	{/if}

	<ol class="progress" aria-label="Where this sub-division stands">
		{#each steps as step (step.id)}
			<li data-state={step.state}>
				<a href={`#${step.id}`} aria-current={step.state === 'current' ? 'step' : undefined}>
					<span class="dot" aria-hidden="true">{step.state === 'done' ? '✓' : step.number}</span>
					<span class="text">
						<span class="label">{step.label}</span>
						<span class="detail"><span class="sr">{STATE_WORDS[step.state]}: </span>{step.detail}</span>
					</span>
				</a>
			</li>
		{/each}
	</ol>
	<p class="sr" role="status">{announcement}</p>

	<div class="work" class:with-map={map !== undefined}>
		{#if map}
			<div class="map-slot" data-map-tool={tool}>
				{@render map(mapProps)}
			</div>
		{/if}

		<div class="flow">
			<h3 id={stepId(1)} tabindex="-1">1. Quaternary and runoff module</h3>
			{#if stage === 1}
				<QuaternaryPick {loaded} {choices} {code} {moduleNumber} disabled={busy} onchoose={chooseQuaternary} onmodule={(n) => (moduleNumber = n)} onupload={chooseUpload} onretry={loadQuaternaries} />
			{/if}
			{#if quaternary || module}
				<dl class="facts provenance" aria-label="What will be split" data-provenance="module">
					{#if quaternary}
						<div><dt>Quaternary</dt><dd data-value="quaternary">{quaternary.code}</dd></div>
						<div><dt>Boundary</dt><dd>{quaternary.source}{boundaryKm2 !== undefined ? `, ${formatNumber(boundaryKm2, 1)} km² on the sphere` : ''}</dd></div>
					{/if}
					{#if module}
						<div><dt>Module</dt><dd data-value="module">{module.label}</dd></div>
						<div><dt>In the network file</dt><dd>{formatNumber(module.areaKm2, 1)} km², MAP {formatNumber(module.mapMm, 0)} mm</dd></div>
						<div>
							<dt>Rainfall file</dt>
							<dd>{module.rainfallFile}, kept by every piece</dd>
						</div>
						{#if module.sfrChildren > 0}
							<div><dt>SFR children</dt><dd>{module.sfrChildren}, split with it by area share</dd></div>
						{/if}
					{/if}
				</dl>
			{/if}
			{#if block}
				<p class="warn"><strong>Can’t split this module:</strong> {block}</p>
			{:else if stage === 1 && earlyCheck?.ok && earlyCheck.value.warning}
				<p class="warn" data-warning="scale"><strong>Check:</strong> {earlyCheck.value.warning}</p>
			{/if}
			{#if stage === 1}
				<div class="actions">
					<button type="button" id="subdivide-continue" class="primary" onclick={begin} disabled={!quaternary || !module || block !== null || busy}>Continue to the split</button>
				</div>
				{#if !quaternary || !module}
					<p class="note">Choose {quaternary ? 'the runoff module' : module ? 'the quaternary' : 'the quaternary and the runoff module'} to go on.</p>
				{/if}
			{:else if confirmRestart}
				<div class="warn" role="alert">
					<p><strong>Start again?</strong> This drops {plural(set?.splits.length ?? 0, 'split')}, the pieces and any calibration.</p>
					<div class="actions">
						<button type="button" id="subdivide-keep" onclick={keepSplits}>Keep them</button>
						<button type="button" onclick={startAgain}>Drop them and start again</button>
					</div>
				</div>
			{:else}
				<div class="actions">
					<button type="button" id="subdivide-restart" onclick={askRestart}>Start again</button>
				</div>
			{/if}

			{#if stage >= 2 && set}
				<h3 id={stepId(2)} tabindex="-1">2. Choose the split</h3>
				{#if set.splits.length > 0}
					<ol class="splits" aria-label="Splits so far">
						{#each set.splits as record, i (i)}<li>{splitLabel(record)}</li>{/each}
					</ol>
				{/if}
				{#if splitting}
					{#if set.pieces.length > 1}
						<div class="field">
							<label for="subdivide-target">Piece to split</label>
							<select id="subdivide-target" bind:value={targetIndex} onchange={clearTool}>
								{#each set.pieces as piece, i (piece.id)}<option value={i}>Piece {i + 1}: {roleLabel(piece.role)}, {formatNumber(piece.polygonKm2, 1)} km²</option>{/each}
							</select>
						</div>
					{/if}
					<fieldset class="kinds">
						<legend>Split by</legend>
						<div class="radio">
							<input type="radio" id="subdivide-kind-tributary" name="subdivide-kind" bind:group={kind} value="tributary" onchange={clearTool} />
							<label for="subdivide-kind-tributary">A tributary: the catchment above a point on a river</label>
						</div>
						<div class="radio">
							<input type="radio" id="subdivide-kind-zone" name="subdivide-kind" bind:group={kind} value="zone" onchange={clearTool} />
							<label for="subdivide-kind-zone">A MAP zone: a high- or low-rainfall area</label>
						</div>
					</fieldset>
					{#if target && quaternary}
						{#key target.id}
							{#if kind === 'tributary'}
								{#if tributary}
									{@render tributary({
										quaternary: quaternary.code,
										within: target.geometry,
										click,
										view,
										onproposal: (geometry) => (proposal = geometry),
										onchannels: (next) => (channels = next),
										onaccept: acceptTributary
									})}
								{:else}
									<p class="note" data-tool="tributary-missing">The tributary tool is not in this build yet. Use a MAP zone, or come back to this step when it is.</p>
								{/if}
							{:else}
								<ZoneTool
									within={target.geometry}
									label={targetLabel}
									{engine}
									{data}
									{drawn}
									canDraw={map !== undefined}
									ontool={(next) => (zoneTool = next)}
									ongrid={(cells) => (gridLayer = cells)}
									onproposal={(zone) => (proposal = zone)}
									onaccept={acceptZone}
								/>
							{/if}
						{/key}
					{/if}
					{#if set.pieces.length > 1}
						<div class="actions">
							<button type="button" onclick={keepPieces}>Keep the pieces as they are</button>
						</div>
					{/if}
				{:else}
					<div class="actions">
						<button type="button" onclick={splitAgain} disabled={set.pieces.length >= MAX_PIECES}>Split a piece again</button>
						<button type="button" onclick={undo}>Undo the last split</button>
					</div>
					{#if set.pieces.length >= MAX_PIECES}
						<p class="note">{MAX_PIECES} pieces is the most a quaternary takes.</p>
					{/if}
				{/if}
			{/if}

			{#if stage >= 3 && set && set.pieces.length > 1 && module}
				<h3 id={stepId(3)} tabindex="-1">3. Review the pieces</h3>
				<p>Numbers match the map. The pieces’ areas are scaled so they add up to the module’s {formatNumber(module.areaKm2, 1)} km² in the network.</p>
				{#if areas?.ok}
					<dl class="facts" aria-label="Scaling the areas">
						<div><dt>Polygons add up to</dt><dd data-value="polygons-total">{formatNumber(set.pieces.reduce((s, p) => s + p.polygonKm2, 0), 1)} km²</dd></div>
						<div><dt>Scale to the module</dt><dd data-value="scale">{formatNumber(areas.value.scale, 3)}</dd></div>
					</dl>
					{#if areas.value.warning}
						<p class="warn" data-warning="scale"><strong>Check:</strong> {areas.value.warning}</p>
					{/if}
				{:else if areas}
					<p class="error" role="alert">The areas could not be scaled: {areas.error}</p>
				{/if}
				<PieceCards {rows} ontyped={typeMap} onretry={retry} />
				{#if showBlockers && blockers.length > 0}
					<div class="blocking" role="alert">
						<p><strong>Fix these before calibrating:</strong></p>
						<ul>
							{#each blockers as b (b.number)}<li>{b.text}</li>{/each}
						</ul>
					</div>
				{/if}

				<h4>What happens to the rest of the module</h4>
				<ul class="shares" aria-label="How each table is shared">
					{#each shareLines(shares) as line (line)}<li>{line}</li>{/each}
				</ul>
				<h4>Changes to the network</h4>
				{#if refusal}
					<div id="subdivide-refused" role="alert" tabindex="-1">
						<p class="error">This split can’t be applied: {refusal}</p>
						<p>Nothing has changed. Undo the last split to try another, or start again with a different module.</p>
					</div>
				{:else if preview?.ok}
					{#each preview.value.messages.filter((m) => !(areas?.ok && m === areas.value.warning)) as message (message)}
						<p class="warn"><strong>Check:</strong> {message}</p>
					{/each}
					<ul class="changes" aria-label="Changes to the network" data-list="changes">
						{#each preview.value.changes as change (change)}<li>{change}</li>{/each}
					</ul>
				{:else if preview}
					<p class="error" role="alert">The changes could not be worked out: {preview.error}</p>
				{:else}
					<p class="note">The changes appear once every piece has a MAP.</p>
				{/if}
				<div class="actions">
					<button type="button" class="primary" onclick={toCalibrate}>Continue to calibrate the MAPs</button>
				</div>
			{/if}
		</div>
	</div>

	{#if stage >= 4 && set && set.pieces.length > 1}
		<h3 id={stepId(4)} tabindex="-1">4. Calibrate the MAPs</h3>
		<CalibrateStep
			{rows}
			{unsplit}
			{unsplitError}
			bind:marText
			bind:citation
			{targetError}
			{calibrating}
			{calibrationError}
			{outcome}
			{stale}
			oncalibrate={calibrate}
			onbest={useBest}
			onchangetarget={changeTarget}
			oncancel={cancelCalibration}
			oncontinue={toApply}
		/>
	{/if}

	{#if showApply && outcome}
		<h3 id={stepId(5)} tabindex="-1">5. Apply, then rerun</h3>
		{#if outcome.result.status !== 'converged'}
			<p class="warn" data-warning="not-converged"><strong>Not converged:</strong> {outcomeSentence(outcome)}</p>
		{/if}
		<p>
			Applying replaces {module?.label} in this browser’s working copy with {set?.pieces.length} runoff modules, rewires the routes as listed in step 3, and records the pieces, the
			grid, the target and every try in <code>pitman.json</code>. The results of the last run no longer match, so they are cleared; save the zip to keep the new network.
		</p>
		<div class="actions">
			<button type="button" class="primary" onclick={apply} disabled={busy}>Apply: split {module?.ref.type} {module?.ref.number} into {set?.pieces.length} modules</button>
			{#if busy}
				<p class="note">A run is in progress; apply when it finishes.</p>
			{/if}
		</div>
		{#if applyError}
			<p id="subdivide-apply-error" class="error" role="alert" tabindex="-1">The split could not be applied: {applyError}</p>
		{/if}
	{/if}
</section>

<style>
	.done {
		width: 100%;
		min-width: 44rem;
		margin-bottom: 0.75rem;
	}
	/* Tiles and charts lift off the tinted block. */
	.applied :global(table) {
		background: var(--surface);
	}
	.progress {
		position: relative;
		list-style: none;
		margin: 1rem 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 0.25rem;
		font-size: var(--font-sm);
	}
	.progress a {
		display: flex;
		gap: 0.4rem;
		align-items: flex-start;
		padding: 0.35rem 0.4rem;
		min-height: var(--control-h);
		border-radius: var(--radius);
		color: var(--text);
		text-decoration: none;
		border-top: 3px solid var(--border);
	}
	.progress a:hover {
		background: var(--accent-soft);
	}
	.progress li[data-state='current'] a {
		border-top-color: var(--accent);
		background: var(--accent-soft);
	}
	.progress li[data-state='done'] a {
		border-top-color: var(--success);
	}
	.dot {
		flex: none;
		width: 1.35rem;
		height: 1.35rem;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		font-size: var(--font-xs);
		font-weight: 700;
	}
	.text {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.label {
		font-weight: 600;
	}
	.detail {
		color: var(--text-muted);
		font-size: var(--font-xs);
		overflow-wrap: anywhere;
	}
	/* Five across won't fit a phone: two columns, the last step across both. */
	@media (max-width: 40rem) {
		.progress {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.progress li:last-child {
			grid-column: span 2;
		}
	}
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
	/* The map stays beside the steps it serves; steps 4 and 5 take the full width for the tables. */
	@media (min-width: 75rem) {
		.work.with-map {
			grid-template-columns: minmax(0, 1fr) minmax(20rem, 40%);
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
			position: sticky;
			top: calc(var(--bar-h) + 1rem);
			height: min(34rem, calc(100vh - var(--bar-h) - 2rem));
		}
	}
	.work .map-slot[data-map-tool='draw'] {
		height: auto;
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
	.kinds {
		margin: 0.75rem 0;
	}
	.radio {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		min-height: var(--control-h);
	}
	.splits,
	.changes,
	.shares {
		padding-left: 1.25rem;
		font-size: 0.9rem;
		margin: 0.5rem 0;
	}
	.blocking {
		background: var(--danger-soft);
		border: 2px solid var(--danger);
		border-radius: var(--radius-lg);
		padding: 0.25rem 1rem;
		margin: 0.75rem 0;
	}
</style>
