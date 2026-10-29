<script lang="ts">
	import { greeting } from '#lib/greeting.js';

	// Reusable presentational component. Props use the Svelte 5 runes API
	// (`$props`). Example only — replace with your own components, and add
	// new ones under `src/lib/components/` (group into subfolders once the
	// folder grows past a flat handful — see CLAUDE.md "Code organization").
	let { name = 'world' }: { name?: string } = $props();
</script>

<p class="greeting">{greeting(name)}</p>

<style>
	.greeting {
		font-size: 1.25rem;
		font-weight: 600;
	}
</style>
