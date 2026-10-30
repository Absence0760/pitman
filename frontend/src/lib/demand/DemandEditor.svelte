<!--
	One demand's form beside its preview. The form holds text (draft.ts); the
	preview is the engine's plan for that text (`planDemand`), so the rows and
	the file on screen are the ones Apply writes. Nothing changes until Apply.
	Every value says where it came from (issue #3, rule 8).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { DemandError, demandTargets, planDemand, type DemandModuleOption, type DemandPlan, type LoadedBundle } from '@pitman/wrsm';
	import { isoDate } from '#lib/extend/apply.js';
	import { MONTH_NAMES } from '#lib/extend/factors.js';
	import { HYDRO_MONTHS, formatNumber, hydroYearLabel } from '#lib/results/format.js';
	import { addGrowthRow, checkDraft, draftSources, evenShares, OFFERED_YEAR, scaledShares, sumLabel, type DemandDraft, type GrowthDraft } from './draft.js';
	import { attachmentLabel, sourceLabel, type DemandFileRow } from './files.js';
	import MonthlyRows from './MonthlyRows.svelte';
	import { emptyFileProblem, flatFrom, planChanges, roundingWarning, targetFrom, worstRounding } from './preview.js';

	let {
		bundle,
		file,
		start,
		onapply,
		onclose,
		busy = false
	}: {
		bundle: LoadedBundle;
		/** The file being edited or replaced; absent for a new one. */
		file?: DemandFileRow;
		start: DemandDraft;
		onapply: (plan: DemandPlan) => void;
		onclose: () => void;
		busy?: boolean;
	} = $props();

	let draft = $state<DemandDraft>(untrack(() => start));
	const check = $derived(checkDraft(draft));
	const today = isoDate();
	const sources = $derived(draftSources(draft, today));

	const options = $derived(demandTargets(bundle));
	const defaultRoute = (o: DemandModuleOption | undefined) => (o === undefined ? '' : o.newRoute !== null ? 'new' : (o.routes.find((r) => r.blocked === null)?.route.toString() ?? ''));
	const moduleId = (o: DemandModuleOption) => `${o.module.type}${o.module.number}`;
	const firstOption = untrack(() => options.find((o) => defaultRoute(o) !== '') ?? options[0]);
	let moduleChoice = $state(firstOption ? moduleId(firstOption) : '');
	let routeChoice = $state(defaultRoute(firstOption));
	let moving = $state(false);
	const chosen = $derived(options.find((o) => moduleId(o) === moduleChoice));
	const canMove = $derived(file?.attachments.length === 1 && file.attachments[0]?.direction === 'out');
	const needsTarget = $derived(file === undefined || moving);
	const target = $derived(needsTarget ? targetFrom(moduleChoice, routeChoice) : undefined);

	const outcome = $derived.by((): { plan: DemandPlan | null; problem: string | null } => {
		if (check.spec === null) return { plan: null, problem: null };
		if (needsTarget && target === undefined) return { plan: null, problem: options.length === 0 ? 'This network has no reservoir or channel reach to attach a demand to.' : 'Choose a route for this demand.' };
		try {
			const request = { spec: check.spec, sources, ...(file !== undefined && { file: file.key }), ...(target !== undefined && { target }) };
			return { plan: planDemand(bundle, request), problem: null };
		} catch (error) {
			if (error instanceof DemandError) return { plan: null, problem: error.message };
			if (error instanceof RangeError) return { plan: null, problem: 'A month is too large for the file, which holds 9,999.99 million m³ at most.' };
			throw error;
		}
	});
	const plan = $derived(outcome.plan);
	const emptyFile = $derived(plan ? emptyFileProblem(plan.years) : null);
	const problems = $derived([...new Set([...Object.values(check.messages), ...(outcome.problem ? [outcome.problem] : []), ...(emptyFile ? [emptyFile] : [])])]);
	const rounding = $derived(plan ? roundingWarning(plan.years) : null);
	const worst = $derived(plan ? worstRounding(plan.years) : null);
	const flat = $derived(plan ? flatFrom(plan) : null);
	const canApply = $derived(plan !== null && emptyFile === null && !busy);

	const title = $derived(file === undefined ? 'New demand' : file.spec ? `Edit ${file.name}` : `Replace ${file.name}`);
	const headingId = 'demand-editor-h';

	function setRow(id: number, change: Partial<GrowthDraft>) {
		draft = { ...draft, growth: draft.growth.map((r) => (r.id === id ? { ...r, ...change } : r)) };
	}
	function removeRow(id: number) {
		draft = { ...draft, growth: draft.growth.filter((r) => r.id !== id) };
	}
	function setShare(k: number, text: string) {
		draft = { ...draft, shares: draft.shares.map((v, i) => (i === k ? text : v)) };
	}
	function onModule(id: string) {
		moduleChoice = id;
		routeChoice = defaultRoute(options.find((o) => moduleId(o) === id));
	}
	const scaled = $derived(scaledShares(draft.shares));
	const hasOffered = $derived(draft.baseYear.trim() === String(OFFERED_YEAR) || draft.growth.some((r) => r.year.trim() === String(OFFERED_YEAR)));
	const yearLabel = (text: string) => (/^\d{4}$/.test(text.trim()) ? hydroYearLabel(Number(text)) : '');
</script>

<div class="editor" data-demand-editor>
	<h3 id={headingId} tabindex="-1">{title}</h3>

	{#if file && !file.spec}
		<p class="warn">
			{file.name} has no spec in pitman.json, so these values are estimates from its rows, a starting point rather than its original inputs. Apply replaces every
			row with what the preview shows.
		</p>
	{:else if file?.specStale}
		<p class="warn">The rows of {file.name} no longer match its spec: the file changed outside Pitman. Apply regenerates every row from the values below.</p>
	{/if}
	{#if file?.shortfall}
		<p class="warn">{file.shortfall} Apply regenerates it to cover the run.</p>
	{/if}

	<div class="work">
		<div class="form">
			<fieldset>
				<legend>Attached to</legend>
				{#if file}
					{#if file.attachments.length === 0}
						<p class="note">Nothing reads this file.</p>
					{:else}
						<ul class="plain">
							{#each file.attachments as a (`${a.module.type}${a.module.number}-${a.route}-${a.direction}`)}
								<li>{attachmentLabel(a)}</li>
							{/each}
						</ul>
					{/if}
					{#if canMove}
						<div class="check">
							<input id="demand-move" type="checkbox" bind:checked={moving} />
							<label for="demand-move">Move it to another route</label>
						</div>
					{:else if file.attachments.length > 0}
						<p class="note">
							{file.attachments.length > 1 ? 'Several routes read this file, so it stays where it is; a change reaches them all.' : 'This is a defined inflow, so it stays where it is.'}
						</p>
					{/if}
				{/if}
				{#if needsTarget}
					{#if options.length === 0}
						<p class="note">This network has no reservoir or channel reach to attach a demand to. Run a network that has one, or add it in WRSM2000 first.</p>
					{:else}
						<div class="field">
							<label for="demand-module">Reservoir or channel reach</label>
							<select id="demand-module" value={moduleChoice} onchange={(e) => onModule(e.currentTarget.value)}>
								{#each options as o (moduleId(o))}
									<option value={moduleId(o)}>{o.module.type} {o.module.number}{o.name ? ` ${o.name}` : ''}</option>
								{/each}
							</select>
						</div>
						<div class="field">
							<label for="demand-route">Route</label>
							<select id="demand-route" bind:value={routeChoice}>
								{#if chosen?.newRoute != null}
									<option value="new">New route {chosen.newRoute}, to the zero sink</option>
								{/if}
								{#each chosen?.routes ?? [] as r (r.route)}
									<option value={String(r.route)} disabled={r.blocked !== null}>Route {r.route} to {r.to}{r.blocked ? `: ${r.blocked}` : ''}</option>
								{/each}
							</select>
						</div>
						{#if chosen?.newRouteBlocked}
							<p class="note">No new route: {chosen.newRouteBlocked}.</p>
						{/if}
						{#if chosen && defaultRoute(chosen) === ''}
							<p class="warn">{chosen.module.type} {chosen.module.number} has no route that can take a demand. Choose another module, or free a route in WRSM2000.</p>
						{/if}
						{#if chosen && !chosen.solved}
							<p class="warn">{chosen.module.type} {chosen.module.number} is not solved (Solve = N in the .NET file), so its routes carry nothing and this demand would have no effect.</p>
						{/if}
					{/if}
				{/if}
			</fieldset>

			<fieldset>
				<legend>Annual volume</legend>
				<div class="pair">
					<div class="field year">
						<label for="demand-base">Base year</label>
						<input
							id="demand-base"
							type="text"
							inputmode="numeric"
							autocomplete="off"
							value={draft.baseYear}
							aria-invalid={check.messages.baseYear ? 'true' : undefined}
							aria-describedby={check.messages.baseYear ? 'demand-base-msg' : 'demand-base-hint'}
							oninput={(e) => (draft = { ...draft, baseYear: e.currentTarget.value })}
						/>
						<span class="sub" id="demand-base-hint">{yearLabel(draft.baseYear) || 'hydrological year'}</span>
					</div>
					<div class="field">
						<label for="demand-annual">Volume in that year</label>
						<div class="line">
							<input
								id="demand-annual"
								type="text"
								inputmode="decimal"
								autocomplete="off"
								value={draft.annual.text}
								aria-invalid={draft.annual.text.trim() !== '' && check.messages.annual ? 'true' : undefined}
								aria-describedby={check.messages.annual ? 'demand-annual-msg' : undefined}
								oninput={(e) => (draft = { ...draft, annual: { ...draft.annual, text: e.currentTarget.value } })}
							/>
							<span class="unit">million m³/a</span>
							<button type="button" onclick={() => (draft = { ...draft, annual: { ...draft.annual, text: draft.annual.start } })} disabled={draft.annual.text === draft.annual.start}>
								Reset<span class="sr"> the annual volume</span>
							</button>
						</div>
					</div>
				</div>
				{#if check.messages.baseYear}
					<p id="demand-base-msg" class="msg">{check.messages.baseYear}</p>
				{/if}
				{#if check.messages.annual && draft.annual.text.trim() !== ''}
					<p id="demand-annual-msg" class="msg">{check.messages.annual}</p>
				{/if}
				<div class="field source">
					<label for="demand-annual-note">Where this comes from</label>
					<input
						id="demand-annual-note"
						type="text"
						maxlength="200"
						value={draft.annual.note}
						oninput={(e) => (draft = { ...draft, annual: { ...draft.annual, note: e.currentTarget.value } })}
					/>
					<span class="sub" data-source="annual">{sourceLabel(sources.annualVolume)}</span>
				</div>
			</fieldset>

			<fieldset>
				<legend>Monthly distribution</legend>
				<p class="note">Share of each year’s volume, %. October first: the hydrological year runs October to September.</p>
				<div class="shares">
					{#each draft.shares as share, k (k)}
						{@const message = check.messages[`share-${k}`]}
						<div class="share">
							<label for={`demand-share-${k}`}><span aria-hidden="true">{HYDRO_MONTHS[k]}</span><span class="sr">{MONTH_NAMES[k]} share, %</span></label>
							<input
								id={`demand-share-${k}`}
								type="text"
								inputmode="decimal"
								autocomplete="off"
								value={share}
								aria-invalid={message ? 'true' : undefined}
								oninput={(e) => setShare(k, e.currentTarget.value)}
							/>
						</div>
					{/each}
				</div>
				<p class="sum" role="status" data-sum-ok={check.messages.shares === undefined && check.sum !== null}>{sumLabel(check.sum)}</p>
				{#each MONTH_NAMES as _, k (k)}
					{#if check.messages[`share-${k}`]}
						<p class="msg">{check.messages[`share-${k}`]}</p>
					{/if}
				{/each}
				<div class="actions">
					<button type="button" onclick={() => (draft = { ...draft, shares: evenShares() })}>Even distribution</button>
					<button type="button" onclick={() => scaled && (draft = { ...draft, shares: scaled })} disabled={scaled === null}>Scale to 100 %</button>
					<button type="button" onclick={() => (draft = { ...draft, shares: draft.sharesStart })} disabled={draft.shares.join() === draft.sharesStart.join()}>
						Reset<span class="sr"> the shares</span>
					</button>
				</div>
				<div class="field source">
					<label for="demand-shares-note">Where these shares come from</label>
					<input id="demand-shares-note" type="text" maxlength="200" value={draft.sharesNote} oninput={(e) => (draft = { ...draft, sharesNote: e.currentTarget.value })} />
					<span class="sub" data-source="shares">{sourceLabel(sources.monthlyDistribution)}</span>
				</div>
			</fieldset>

			<fieldset>
				<legend>Growth</legend>
				<p class="note">The volume in later years. Pitman interpolates straight lines between them and holds the volume flat before the base year and after the last year.</p>
				{#each draft.growth as row (row.id)}
					{@const yearId = `demand-year-${row.id}`}
					{@const volumeId = `demand-volume-${row.id}`}
					{@const yearMessage = check.messages[`year-${row.id}`]}
					{@const volumeMessage = check.messages[`volume-${row.id}`]}
					{@const year = Number(row.year)}
					<div class="growth" data-growth-year={row.year}>
						<div class="pair">
							<div class="field year">
								<label for={yearId}>Year</label>
								<input id={yearId} type="text" inputmode="numeric" autocomplete="off" value={row.year} aria-invalid={yearMessage ? 'true' : undefined} oninput={(e) => setRow(row.id, { year: e.currentTarget.value })} />
								<span class="sub">{yearLabel(row.year) || 'hydrological year'}</span>
							</div>
							<div class="field">
								<label for={volumeId}>Volume<span class="sr"> in {row.year}</span></label>
								<div class="line">
									<input id={volumeId} type="text" inputmode="decimal" autocomplete="off" value={row.text} aria-invalid={volumeMessage ? 'true' : undefined} oninput={(e) => setRow(row.id, { text: e.currentTarget.value })} />
									<span class="unit">million m³/a</span>
									<button type="button" onclick={() => removeRow(row.id)}>Remove<span class="sr"> {row.year || 'this row'}</span></button>
								</div>
							</div>
						</div>
						{#if yearMessage}<p class="msg">{yearMessage}</p>{/if}
						{#if volumeMessage}<p class="msg">{volumeMessage}</p>{/if}
						{#if check.blankRows.includes(row.id)}
							<p class="note">Left out until it has a volume. Without it the demand stays at the last volume above.</p>
						{:else}
							<div class="field source">
								<label for={`${yearId}-note`}>Where this comes from</label>
								<input id={`${yearId}-note`} type="text" maxlength="200" value={row.note} oninput={(e) => setRow(row.id, { note: e.currentTarget.value })} />
								{#if yearMessage === undefined && row.year.trim() !== ''}
									<span class="sub" data-source={`growth-${row.year}`}>{sourceLabel(sources.growth[year])}</span>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
				<div class="actions">
					<button type="button" onclick={() => (draft = addGrowthRow(draft))}>Add a year</button>
					{#if !hasOffered}
						<button type="button" onclick={() => (draft = addGrowthRow(draft, String(OFFERED_YEAR)))}>Add {OFFERED_YEAR}</button>
					{/if}
				</div>
			</fieldset>

			<details>
				<summary>How the file is made</summary>
				<p class="note">
					Each year’s volume A is taken from the base year and the growth years; each month is A × its share. WRSM2000 has no growth setting of its own, so the file
					simply holds each month’s volume: year, then 12 values October to September in million m³, two decimals, no annual column (docs: formats § 12). It covers every
					year of the run, because a defined flow must (TT 689 p.150), and carries on to the last growth year.
				</p>
			</details>
		</div>

		<div class="preview" aria-labelledby="demand-preview-h" role="group">
			<h4 id="demand-preview-h">What Apply would write</h4>
			{#if plan === null || emptyFile}
				<div class="paused" data-preview="paused">
					<p><strong>Preview paused.</strong> {problems.length === 1 ? 'One thing to fix:' : 'To go on:'}</p>
					<ul>
						{#each problems as problem (problem)}
							<li>{problem}</li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if plan}
				<dl class="facts provenance">
					<div><dt>File</dt><dd data-fact="file">{plan.fileName}</dd></div>
					<div><dt>Years</dt><dd data-fact="years">{hydroYearLabel(plan.firstYear)} to {hydroYearLabel(plan.lastYear)}</dd></div>
					{#if file}
						<div><dt>Mean annual now</dt><dd>{formatNumber(file.meanAnnualMm3, 2)} million m³/a</dd></div>
					{/if}
					<div>
						<dt>Volume</dt>
						<dd data-fact="volume">
							{#if plan.request.spec.growth.length < 2}
								{formatNumber(plan.request.spec.annualVolumeMm3, 3)} million m³/a in every year
							{:else}
								{formatNumber(plan.request.spec.growth[0]?.value, 3)} to {formatNumber(plan.request.spec.growth.at(-1)?.value, 3)} million m³/a, flat from {flat === null ? '' : hydroYearLabel(flat)}
							{/if}
						</dd>
					</div>
					{#if worst}
						<div><dt>Largest rounding</dt><dd data-fact="rounding">{formatNumber(Math.abs(worst.differencePercent), 2)} %, {hydroYearLabel(worst.year)}</dd></div>
					{/if}
				</dl>
				<ul class="changes">
					{#each planChanges(plan, bundle.network) as line (line)}
						<li>{line}</li>
					{/each}
				</ul>
				{#if rounding}
					<p class="warn" data-warning="rounding">{rounding}</p>
				{/if}
				{#if file && !file.spec}
					<p class="note">The zip you loaded keeps the old file; only the working copy and later saves change.</p>
				{/if}
			{/if}
			<div class="actions">
				<button type="button" class="primary" disabled={!canApply} onclick={() => plan && onapply(plan)}>Apply to the working copy</button>
				<button type="button" onclick={onclose}>Cancel</button>
				{#if busy}
					<span class="note">Wait for the run to finish.</span>
				{/if}
			</div>
			{#if plan}
				<MonthlyRows rows={plan.series.rows} checks={plan.years} caption="Rows of the file, million m³ a month, October first" />
				<details class="text">
					<summary>The file as text</summary>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex (a box that scrolls must be reachable by keyboard) -->
					<pre tabindex="0" aria-label={`${plan.fileName} as written`}>{plan.text.replaceAll('\r\n', '\n')}</pre>
				</details>
			{/if}
		</div>
	</div>
</div>

<style>
	.editor {
		margin-top: 1rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}
	h3:focus {
		outline: none;
	}
	.work {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem 1.5rem;
		margin-top: 0.75rem;
	}
	/* The preview stays in view beside the form, however long the form runs. */
	@media (min-width: 75rem) {
		.work {
			grid-template-columns: minmax(0, 27rem) minmax(0, 1fr);
			align-items: start;
		}
		.preview {
			position: sticky;
			top: calc(var(--bar-h) + 0.75rem);
			max-height: calc(100vh - var(--bar-h) - 1.5rem);
			overflow-y: auto;
		}
	}
	.form,
	.preview {
		min-width: 0;
	}
	h4 {
		margin: 0 0 0.25rem;
	}
	fieldset {
		margin: 0 0 1rem;
		padding: 0.5rem 0.75rem 0.75rem;
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
	}
	legend {
		font-weight: 650;
		padding: 0 0.25rem;
	}
	fieldset .note {
		margin: 0 0 0.5rem;
		font-size: var(--font-sm);
	}
	.plain {
		margin: 0 0 0.25rem;
		padding: 0;
		list-style: none;
		font-size: 0.9rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
		margin-top: 0.4rem;
	}
	.field label {
		font-size: 0.875rem;
		font-weight: 600;
	}
	.field select,
	.field input {
		width: 100%;
	}
	.pair {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.75rem;
	}
	.pair .field {
		flex: 1 1 13rem;
	}
	.pair .field.year {
		flex: 0 0 6rem;
	}
	.line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.line input {
		flex: 1 1 5rem;
		min-width: 4rem;
		width: 4rem;
	}
	.unit {
		font-size: var(--font-sm);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.sub {
		font-size: var(--font-sm);
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.source label {
		font-weight: 400;
	}
	.check {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		min-height: var(--control-h);
		font-size: 0.9rem;
	}
	.msg {
		margin: 0.3rem 0 0;
		padding-left: 0.5rem;
		border-left: 4px solid var(--danger);
		color: var(--danger);
		font-size: 0.875rem;
	}
	.shares {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.4rem 0.5rem;
	}
	/* Three a row on a phone keeps 8.3333 whole, and reads as the year's quarters. */
	@media (max-width: 30rem) {
		.shares {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	.share {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}
	.share label {
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.share input {
		width: 100%;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.sum {
		margin: 0.4rem 0;
		font-size: 0.9rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.sum[data-sum-ok='false'] {
		color: var(--danger);
	}
	.growth {
		padding: 0.25rem 0 0.5rem;
		border-bottom: 1px solid var(--border);
		margin-bottom: 0.5rem;
	}
	.paused {
		border-left: 4px solid var(--warning);
		background: var(--warning-soft);
		border-radius: var(--radius);
		padding: 0.25rem 0.75rem;
		font-size: 0.9rem;
		margin: 0.5rem 0;
	}
	.paused p {
		margin: 0.25rem 0;
	}
	.paused ul,
	.changes {
		margin: 0.25rem 0 0.5rem;
		padding-left: 1.25rem;
		font-size: 0.9rem;
	}
	.preview .actions {
		margin: 0.75rem 0;
	}
	.text pre {
		overflow: auto;
		max-height: 20rem;
		margin: 0.5rem 0 0;
		padding: 0.5rem;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-size: var(--font-sm);
	}
	details {
		margin-top: 0.5rem;
	}
	summary {
		min-height: var(--control-h);
		cursor: pointer;
	}
</style>
