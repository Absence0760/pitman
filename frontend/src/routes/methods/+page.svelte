<!--
	The Methods page: what the model does, how far it agrees with WRSM2000, what
	isn't modelled, the departures, and where the data comes from. Static, so it
	prerenders under adapter-static; the facts are data in content.ts, which
	content.test.ts holds to the engine and the docs. Text column about 75ch.
-->
<script lang="ts">
	import { scrollable } from '#lib/shell/scrollable.js';
	import AppBar from '#lib/shell/AppBar.svelte';
	import { AGREEMENT, COMPARISON_DATE, DATA_SOURCES, DEPARTURES, FEATURE_GROUPS, MANUALS, READINGS, type FeatureStatus } from './content.js';

	const contents = [
		['agreement', 'How far it agrees with WRSM2000'],
		['model', 'What the model does'],
		['features', 'What is modelled and what isn’t'],
		['departures', 'Departures from WRSM2000'],
		['readings', 'Where the manuals leave a choice'],
		['data', 'Data sources and attribution'],
		['manuals', 'The manuals']
	] as const;

	const tone: Record<FeatureStatus, string> = { Modelled: 'good', Partly: 'part', 'Not yet': 'none' };
</script>

<svelte:head>
	<title>Methods: how Pitman works, and how far to trust it</title>
	<meta name="description" content="What Pitman models, how it compares with WRSM2000, what isn't modelled yet, and where its data comes from." />
</svelte:head>

<AppBar />

<main id="main" tabindex="-1" class="page">
	<p class="back"><a href="/">Back to Pitman</a></p>
	<h1>Methods</h1>
	<p class="lede">
		Pitman rebuilds the monthly WRSM/Pitman rainfall-runoff model, the one behind WR90, WR2005 and WR2012, from the published Water Research Commission
		manuals. It reads a WRSM2000 network, runs it in the browser, and saves it back as WRSM2000 files. No code comes from WRSM2000’s program: only the manuals,
		and the data in network files and their outputs.
	</p>
	<p class="warn">
		Pitman is still being built and doesn’t yet reproduce WRSM2000 across a whole network. Irrigation, in particular, is new and hasn’t been compared with WRSM2000. Check anything you rely on
		by saving the network and opening it in WRSM2000.
	</p>

	<nav aria-label="On this page">
		<ol class="contents">
			{#each contents as [id, label] (id)}
				<li><a href={`#${id}`}>{label}</a></li>
			{/each}
		</ol>
	</nav>

	<section aria-labelledby="agreement">
		<h2 id="agreement">How far it agrees with WRSM2000</h2>
		<p>
			Correctness here means the documented hydrology plus a comparison with WRSM2000’s own outputs on a local set of reference networks. A difference is either
			explained under <a href="#departures">departures</a> or treated as a bug. The latest comparison, of {COMPARISON_DATE}, with default settings:
		</p>
		<div class="scroll" use:scrollable>
			<table class="wide">
				<caption>Comparison with WRSM2000 outputs, in percentages</caption>
				<thead>
					<tr><th scope="col">What was compared</th><th scope="col">Result</th></tr>
				</thead>
				<tbody>
					{#each AGREEMENT as row (row.what)}
						<tr><th scope="row">{row.what}</th><td>{row.result}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p>
			That is not yet agreement. The known causes: those figures predate the irrigation model, which hasn’t been compared yet; SFR children respond differently from WRSM2000 at the same parameters, and free Sami
			modules run about 0.7 % high, a residual that sits in the surface volume. The goal is every reference network within 5 % of MAR at every gauge, or a recorded
			reason why not. It hasn’t been reached.
		</p>
	</section>

	<section aria-labelledby="model">
		<h2 id="model">What the model does</h2>

		<h3>Rainfall</h3>
		<p>
			A rainfall file (<code>.RAN</code>) holds each month as a percentage of the mean annual precipitation (MAP). A module’s rain in millimetres is that percentage
			times its own MAP (TT 690 §1.3). Hydrological years run October to September; a row labelled 1990 is October 1990 to September 1991.
		</p>

		<h3>Runoff</h3>
		<p>
			Each month a runoff module takes off the paved fraction and an interception loss (TT 690 p.3 eqs. 1.6–1.7), then splits the rain into four sub-steps along an
			S-shaped curve (TT 690 pp.1–2). Each sub-step runs a single soil-moisture store. Surface runoff comes from a triangular spread of absorption rates between
			ZMIN and ZMAX (TT 690 pp.3–4 eqs. 1.8–1.12). Subsurface flow is a power of soil moisture, <code>Q = FT [(S − SL) / (ST − SL)]^POW</code> (TT 690 p.4 eq. 1.13),
			and up to GW of it counts as baseflow. Evaporation falls with soil moisture through R (TT 690 p.5). Water above capacity spills. The fast and slow parts are
			lagged by TL and GL, then converted to million m³ (TT 690 §1.9 pp.5–6).
		</p>

		<h3>Sami groundwater</h3>
		<p>
			In a Sami module the same soil store runs with GW and GL at zero (TT 691 p.123), on the module’s own Sami parameter set (L.035). Sami then works through the
			record: recharge from soil moisture, a percolating store, an aquifer that loses water to riparian evaporation, regional outflow and baseflow, transmission
			losses from the river, and abstractions (TT 690 ch.8; TT 687). Sami doesn’t feed back into the soil store (TT 691 pp.186–187).
		</p>

		<h3>Land use</h3>
		<p>
			An SFR child takes its parent’s climate and parameters, runs unreduced over its afforested or invaded area, and has PI, FF, SL and ST adjusted until its runoff
			shows the target reductions in MAR and low flow (TT 690 §11.2 p.126, eqs. 11.2–11.3). The parent runs on what is left of its area and adds its children’s flows.
			Afforestation targets come from Smoothed Gush (TT 690 eq. 11.1) or the user; alien vegetation targets from the CSIR biomass curves (TT 690 eqs. 12.3–12.9).
		</p>

		<h3>Reservoirs, channels and the network</h3>
		<p>
			A reservoir does one monthly mass balance: inflow, drafts, net evaporation on the area at the start of the month, and spill above full supply (TT 690 ch.2).
			When water runs short, drafts are cut in the order of TT 689 ch.8. A channel reach has no lag: it takes a bed loss, meets defined flows, and passes the rest on.
			The network is solved one module at a time over the whole record, in the <code>.NET</code> file’s order (TT 689 §6.1.16).
		</p>

		<h3>Run modes</h3>
		<p>
			Present day holds development at a chosen year over the whole rainfall record. Natural removes it: dams, irrigation, abstractions, paved areas and SFR effects
			(TT 689 p.27). Historical follows the files’ year tables, and is the mode to compare with a gauge.
		</p>

		<h3>Fit statistics</h3>
		<p>
			The fit tables show WR2012’s five statistics of annual flow (MAR, mean log, standard deviation, log standard deviation and the seasonal index, TT 689 pp.61–62)
			with the coefficient of variation. The guidelines are those of TT 689 p.177, which the manual itself calls guidelines rather than firm criteria: errors under 4 %
			for MAR and mean log, 6 % for the standard deviations, 8 % for the seasonal index. Years with any unusable observed month are left out of both sides.
		</p>

		<h3>Extending rainfall with CHIRPS</h3>
		<p>
			CHIRPS is averaged over the area a rainfall file represents and summed to hydrological months, then expressed as a percentage of its own MAP. Over the years both
			cover, the ratio of the two records gives twelve monthly bias factors. You see the fit and can change any factor. The corrected CHIRPS years are appended and
			recorded in <code>pitman.json</code> as CHIRPS-derived.
		</p>

		<h3>Sub-dividing a quaternary</h3>
		<p>
			A quaternary splits by a tributary’s catchment or by a MAP zone. A piece exists only to give a module its own area and MAP: every piece shares the quaternary’s
			percentage rainfall. Each piece starts at the gridded MAP over its boundary, then all are scaled by one common factor until the natural MAR at the outlet is within
			2 % of the target (decision D2). This arrives with the map.
		</p>
	</section>

	<section aria-labelledby="features">
		<h2 id="features">What is modelled and what isn’t</h2>
		<div class="scroll" use:scrollable>
			<table class="wide matrix">
				<caption>Supported features</caption>
				<thead>
					<tr><th scope="col">Feature</th><th scope="col">Status</th><th scope="col">Detail</th></tr>
				</thead>
				{#each FEATURE_GROUPS as group (group.title)}
					<tbody>
						<tr class="group"><th colspan="3" scope="colgroup">{group.title}</th></tr>
						{#each group.features as feature (feature.name)}
							<tr>
								<th scope="row">{feature.name}</th>
								<td><span class="pill" data-tone={tone[feature.status]}>{feature.status}</span></td>
								<td>{feature.detail}</td>
							</tr>
						{/each}
					</tbody>
				{/each}
			</table>
		</div>
	</section>

	<section aria-labelledby="departures">
		<h2 id="departures">Departures from WRSM2000</h2>
		<p>Every known difference with a settled cause. Sizes are from the comparison with WRSM2000’s logs.</p>
		<dl class="register">
			{#each DEPARTURES as d (d.id)}
				<div>
					<dt><strong>{d.id}</strong> {d.module}</dt>
					<dd>{d.summary}</dd>
				</div>
			{/each}
		</dl>
		<p>
			Differences still being traced aren’t listed as departures. They are the gaps named under <a href="#agreement">agreement</a>: the surface-volume residual on free
			Sami modules, the response of SFR children, the riparian deduction on dry alien children, and irrigation.
		</p>
	</section>

	<section aria-labelledby="readings">
		<h2 id="readings">Where the manuals leave a choice</h2>
		<p>Where the manuals are silent or misprinted, each choice is recorded with its evidence. The ones that matter most:</p>
		<dl class="register">
			{#each READINGS as r (r.topic)}
				<div>
					<dt><strong>{r.topic}</strong></dt>
					<dd>{r.text}</dd>
				</div>
			{/each}
		</dl>
	</section>

	<section aria-labelledby="data">
		<h2 id="data">Data sources and attribution</h2>
		<p>
			Your network stays in your browser. To extend rainfall, Pitman sends only the area’s outline to its data service, never a network file. Sources marked “With the map” or “Planned” aren’t used yet.
		</p>
		<dl class="register sources">
			{#each DATA_SOURCES as s (s.name)}
				<div>
					<dt>
						<strong>{#if s.url}<a href={s.url}>{s.name}</a>{:else}{s.name}{/if}</strong>
						<span class="pill" data-tone={s.status === 'In use' ? 'good' : s.status === 'Licence pending' ? 'none' : 'part'}>{s.status}</span>
					</dt>
					<dd>{s.usedFor}</dd>
					<dd class="fine">Licence: {s.licence}</dd>
					<dd class="fine">Credit: {s.credit}</dd>
				</div>
			{/each}
		</dl>
		<p class="fine">Software in the page: Inter (SIL OFL 1.1), uPlot and fflate (MIT). Pitman’s own code is MIT licensed.</p>
	</section>

	<section aria-labelledby="manuals">
		<h2 id="manuals">The manuals</h2>
		<p>Page numbers on this page are the printed ones. All four are published by the Water Research Commission.</p>
		<ul>
			{#each MANUALS as m (m.id)}
				<li><a href={m.url}>{m.id}</a>, {m.title}</li>
			{/each}
		</ul>
	</section>
</main>

<style>
	.page {
		max-width: 75ch;
		margin: 0 auto;
		padding: 1rem 1.25rem 3rem;
		line-height: 1.6;
	}
	.back {
		margin: 0.5rem 0;
		font-size: var(--font-sm);
	}
	h1 {
		margin: 0.25rem 0 0.5rem;
	}
	.lede {
		font-size: 1.05rem;
	}
	.contents {
		margin: 1rem 0;
		padding-left: 1.25rem;
	}
	.contents li {
		min-height: 1.75rem;
	}
	section {
		margin-top: 2.5rem;
		scroll-margin-top: calc(var(--bar-h) + 1rem);
	}
	h3 {
		margin: 1.5rem 0 0.25rem;
	}
	.wide {
		width: 100%;
		min-width: 34rem;
	}
	.wide tbody th {
		font-weight: 600;
		text-align: left;
	}
	.matrix tbody th {
		width: 30%;
	}
	.matrix .group th {
		background: var(--surface-2);
		font-weight: 650;
	}
	.pill {
		display: inline-block;
		padding: 0 0.45rem;
		border-radius: var(--radius);
		font-size: var(--font-sm);
		font-weight: 600;
		white-space: nowrap;
	}
	.pill[data-tone='good'] {
		color: var(--success);
		background: var(--success-soft);
	}
	.pill[data-tone='part'] {
		color: var(--warning);
		background: var(--warning-soft);
	}
	.pill[data-tone='none'] {
		color: var(--danger);
		background: var(--danger-soft);
	}
	.register {
		display: grid;
		gap: 0.75rem;
		margin: 0.75rem 0;
	}
	.register div {
		border-left: 3px solid var(--border-strong);
		padding-left: 0.75rem;
	}
	.register dd {
		margin: 0;
	}
	.sources dt {
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 0.5rem;
		align-items: baseline;
	}
	.fine {
		font-size: var(--font-sm);
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
</style>
