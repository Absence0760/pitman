<!--
	The first screen, before a network is loaded: what Pitman is, the two
	promises about the user's files, and the load panel beside them.
-->
<script lang="ts">
	import LoadPanel from '#lib/network/LoadPanel.svelte';
	import type { SourceFile } from '#lib/network/sources.js';

	let { onload, busy = false }: { onload: (sources: SourceFile[]) => void; busy?: boolean } = $props();
</script>

<div class="band">
	<svg class="flow" viewBox="0 0 1200 160" preserveAspectRatio="none" aria-hidden="true">
		<path class="back" d="M0 160V96C70 92 110 98 150 90 190 80 205 30 236 28 268 26 290 80 360 92 430 104 480 92 530 98 566 102 584 62 610 60 638 58 664 92 730 100 800 108 850 94 900 98 934 102 952 44 980 42 1012 40 1050 82 1110 94 1150 100 1180 96 1200 98V160Z" />
		<path class="front" d="M0 160V118C60 112 90 116 120 110 150 104 165 58 190 56 215 54 240 96 300 108 360 120 400 112 440 116 470 118 490 88 512 86 536 84 560 108 620 116 690 124 720 110 760 116 790 120 812 46 838 44 866 42 900 92 980 110 1060 124 1120 112 1200 118V160Z" />
	</svg>
	<div class="inner">
		<div class="pitch">
			<p class="kicker">Monthly rainfall-runoff modelling</p>
			<h1>Bring a WRSM2000 network up to date, in your browser</h1>
			<p class="lede">
				A rebuild of the WRSM2000 / Pitman monthly rainfall-runoff model, written from the Water Research Commission's published manuals (TT 687, 689, 690 and
				691). Load a WRSM2000 network, run it, and save it back as files WRSM2000 opens.
			</p>
			<ul class="promises">
				<li>
					<strong>Your files stay in your browser.</strong> No network file is uploaded: the network is read, run and saved on this computer. Extending rainfall
					with CHIRPS sends only the boundary of the area you upload.
				</li>
				<li>
					The browser keeps a <strong>working copy</strong> so a reload picks up where you were. Your own copy is the zip you save; you can forget the working
					copy at any time.
				</li>
			</ul>
		</div>
		<section class="card load" aria-labelledby="load-h">
			<h2 id="load-h">Load a network</h2>
			<LoadPanel {onload} {busy} />
		</section>
	</div>
</div>

<style>
	.band {
		position: relative;
		overflow: hidden;
		display: grid;
		align-items: center;
		background: linear-gradient(170deg, var(--bar-bg) 40%, var(--bar-bg-2));
		color: var(--bar-text);
	}
	.flow {
		position: absolute;
		left: 0;
		bottom: 0;
		width: 100%;
		height: 11rem;
	}
	.flow path {
		fill: var(--bar-accent);
	}
	.flow .back {
		opacity: 0.07;
	}
	.flow .front {
		opacity: 0.11;
	}
	.inner {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 2rem;
		width: 100%;
		max-width: 78rem;
		margin: 0 auto;
		padding: 2.5rem 1.25rem 3rem;
	}
	@media (min-width: 60rem) {
		.inner {
			grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
			gap: 3.5rem;
			padding: 4rem 1.25rem 4.5rem;
			align-items: center;
		}
	}
	.kicker {
		margin: 0 0 0.5rem;
		color: var(--bar-accent);
		font-size: var(--font-sm);
		font-weight: 600;
	}
	h1 {
		font-size: clamp(1.9rem, 3.4vw, 2.75rem);
		line-height: 1.12;
		letter-spacing: -0.02em;
		margin: 0 0 1rem;
		max-width: 20ch;
	}
	.lede {
		color: var(--bar-muted);
		font-size: 1.05rem;
		max-width: 60ch;
		margin: 0 0 1.25rem;
	}
	.promises {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
		max-width: 60ch;
		font-size: 0.925rem;
	}
	.promises li {
		padding-left: 0.85rem;
		border-left: 2px solid var(--bar-accent);
		color: var(--bar-muted);
	}
	.promises strong {
		color: var(--bar-text);
	}
	.load {
		color: var(--text);
	}
</style>
