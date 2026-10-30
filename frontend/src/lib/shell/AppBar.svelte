<!--
	The bar across every screen: the name, and with a network loaded its code,
	record and run status, and Save. Save lives here so it stays in reach from
	any step; the page owns what it does.
-->
<script lang="ts">
	import type { StepState } from './steps.js';

	let {
		network,
		years,
		run,
		onsave
	}: {
		network?: string;
		years?: string;
		run?: { text: string; tone: StepState };
		onsave?: () => void;
	} = $props();
</script>

<header class="bar">
	<div class="brand">
		<svg class="mark" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
			<rect width="32" height="32" rx="7" />
			<path d="M4 24c5 0 6-15 10-15s4 10 14 13" />
		</svg>
		<span class="name">Pitman</span>
		<span class="tagline">WRSM2000 in your browser</span>
	</div>
	{#if network}
		<div class="context">
			<span class="network"><span class="sr">Network </span>{network}</span>
			{#if years}<span class="years">{years}</span>{/if}
			{#if run}<span class="pill" data-tone={run.tone}>{run.text}</span>{/if}
		</div>
	{/if}
	{#if onsave}
		<button type="button" class="save" onclick={onsave}>Save as WRSM2000 zip</button>
	{/if}
</header>

<style>
	.bar {
		/* The page's focus colour is lost on the dark bar. */
		--focus: var(--bar-accent);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1.25rem;
		min-height: var(--bar-h);
		padding: 0.5rem 1.25rem;
		background: var(--bar-bg);
		color: var(--bar-text);
		border-bottom: 1px solid var(--bar-border);
	}
	/* A phone keeps its screen for the work: the bar only sticks with room to spare. */
	@media (min-width: 48rem) {
		.bar {
			position: sticky;
			top: 0;
			z-index: 10;
		}
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.mark rect {
		fill: var(--bar-bg-2);
		stroke: var(--bar-border);
	}
	.mark path {
		fill: none;
		stroke: var(--bar-accent);
		stroke-width: 3;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.name {
		font-size: 1.125rem;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	.tagline {
		color: var(--bar-muted);
		font-size: var(--font-sm);
	}
	@media (max-width: 64rem) {
		.tagline {
			display: none;
		}
	}
	.context {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		min-width: 0;
		padding-left: 1.25rem;
		border-left: 1px solid var(--bar-border);
		font-size: 0.9rem;
	}
	.network {
		font-family: var(--font-mono);
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.years {
		color: var(--bar-muted);
		font-variant-numeric: tabular-nums;
	}
	.pill {
		font-size: var(--font-xs);
		font-weight: 600;
		padding: 0.1rem 0.55rem;
		border-radius: 999px;
		border: 1px solid var(--bar-border);
		color: var(--bar-text);
		background: var(--bar-bg-2);
	}
	.pill[data-tone='done'] {
		border-color: var(--bar-accent);
	}
	.pill[data-tone='active'] {
		border-style: dashed;
		border-color: var(--bar-accent);
	}
	.pill[data-tone='failed'] {
		background: var(--danger-soft);
		border-color: var(--danger);
		color: var(--text);
	}
	.save {
		margin-left: auto;
		background: var(--bar-accent);
		border-color: var(--bar-accent);
		color: var(--bar-bg);
		font-weight: 650;
	}
	.save:hover:not(:disabled) {
		background: var(--bar-text);
		border-color: var(--bar-text);
	}
</style>
