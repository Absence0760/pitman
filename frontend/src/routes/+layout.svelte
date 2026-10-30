<script lang="ts">
	import type { Snippet } from 'svelte';

	import '../app.css';

	// Svelte 5 renders child routes through a `children` snippet rather
	// than the legacy `<slot />`.
	let { children }: { children: Snippet } = $props();
</script>

<a class="skip" href="#main">Skip to the page</a>
{@render children()}
