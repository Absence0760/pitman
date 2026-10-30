<!--
	The map on its own, so frontend/e2e/map.spec.ts can reach it before (and
	without) the page's integration. No data of its own: it shows what the API
	gives. `?tool=point` or `?tool=draw` shows the bare map with that tool, the
	way the sub-division wizard will use it. Not linked from anywhere. Delete it,
	and point the spec at `/`, once the panel and the wizard are on the main page.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { QuaternaryCollection } from '@pitman/wrsm';
	import { API_BASE_URL } from '#lib/extend/api-base.js';
	import { fetchQuaternaries } from '#lib/map/api.js';
	import type { MapTool } from '#lib/map/contract.js';
	import Map from '#lib/map/Map.svelte';
	import MapPanel from '#lib/map/MapPanel.svelte';

	let picked = $state('');
	let tool = $state<MapTool | null>(null);
	let quaternaries = $state.raw<QuaternaryCollection | null>(null);

	onMount(() => {
		const asked = new URLSearchParams(location.search).get('tool');
		if (asked !== 'point' && asked !== 'draw') return;
		tool = asked;
		void fetchQuaternaries({ baseUrl: API_BASE_URL }).then((q) => (quaternaries = q));
	});
</script>

<svelte:head>
	<title>Map preview · Pitman</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main>
	<h1>Map preview</h1>
	{#if tool}
		<Map {quaternaries} selected={null} {tool} onpoint={(p) => (picked = JSON.stringify(p))} ondraw={(g) => (picked = JSON.stringify(g))} />
	{:else}
		<MapPanel onselect={(code) => (picked = code)} />
	{/if}
	<p data-testid="map-preview-picked">{picked}</p>
</main>

<style>
	main {
		max-width: 72rem;
		margin: 1rem auto;
		padding: 0 1rem;
	}
</style>
