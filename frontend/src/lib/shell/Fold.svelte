<!--
	A card that starts closed, around a panel's own <section class="card">: the
	heading stays, and everything else under it is taken out of view and out of
	the tab order, but stays mounted, so a half-done extension or a typed table
	is there when it opens again. A closed map isn't near the view, so its
	WebGL context isn't made until it opens (Map.svelte). The page owns `open`,
	because the step rail opens a card too.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		id,
		title,
		status,
		open,
		ontoggle,
		children
	}: {
		/** The id of the panel's heading: what the rail links to. */
		id: string;
		title: string;
		/** Where this step stands, from the rail. */
		status: string;
		open: boolean;
		ontoggle: (id: string) => void;
		children: Snippet;
	} = $props();
</script>

<div class="fold" data-open={open} data-fold={id}>
	<div class="head">
		<span class="state">{status}</span>
		<button type="button" aria-expanded={open} onclick={() => ontoggle(id)}>{open ? 'Hide' : 'Show'}<span class="sr"> {title}</span></button>
	</div>
	{@render children()}
</div>

<style>
	.fold {
		position: relative;
		min-width: 0;
	}
	.head {
		position: absolute;
		z-index: 1;
		top: 0.75rem;
		right: 1.5rem;
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.state {
		color: var(--text-muted);
		font-size: var(--font-sm);
	}
	.fold[data-open='true'] .state {
		display: none;
	}
	.fold > :global(section) {
		padding-top: 0.75rem;
	}
	.fold > :global(section > h2) {
		padding-right: 5rem;
		margin-bottom: 0;
		min-height: var(--control-h);
		display: flex;
		align-items: center;
	}
	.fold[data-open='true'] > :global(section > h2) {
		margin-bottom: 0.75rem;
	}
	.fold[data-open='false'] > :global(section) {
		padding-bottom: 0.75rem;
	}
	.fold[data-open='false'] > :global(section > :not(h2)) {
		display: none;
	}
	/* A phone has no room beside the title: the state takes a line under it. */
	@media (max-width: 40rem) {
		.head {
			right: 1rem;
		}
		.state {
			position: absolute;
			top: calc(var(--control-h) + 0.1rem);
			right: 0;
			white-space: nowrap;
		}
		.fold[data-open='false'] > :global(section) {
			padding-bottom: 1.6rem;
		}
	}
</style>
