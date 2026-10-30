<!--
	The tributary tool (subdivide.md § Hydrological split): the panel beside the map. It never touches the
	map: it hands the parent the channels to draw (`onchannels`) and the outline to show (`onproposal`), and
	the parent passes the map's click in with `point(lngLat)` (`bind:this`), wired to `Map`'s `onpoint` with
	`tool="point"`. Accept hands the answer over (`onresult`). The wording is in present.ts, the requests in
	api.ts (tested there); this component holds the state.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { AreaGeometry, ChannelCollection, DelineateResponse } from '@pitman/wrsm';
	import { API_BASE_URL } from '#lib/extend/api-base.js';
	import { fetchChannelsOver, fetchDelineation, TributaryRequestError, type DelineateAnswer, type LargerChannel } from './api.js';
	import { demFacts, largerChannelOffer, pansNote, proposalFacts, warningText } from './present.js';

	type Click = readonly [number, number];

	let {
		within,
		click: mapClick = null,
		baseUrl = API_BASE_URL,
		onresult,
		onchannels,
		onproposal
	}: {
		/** The piece being split: the quaternary, or a piece of it. */
		within: AreaGeometry;
		/** The latest click on the map; a new one delineates, as `point()` does. */
		click?: Click | null;
		/** The API base; the app's by default. */
		baseUrl?: string;
		/** Accept: the answer, and the click that made it (for the sidecar). */
		onresult: (response: DelineateResponse, click: Click) => void;
		/** The terrain channels to draw, growing as they arrive; `null` while there are none. */
		onchannels?: (channels: ChannelCollection | null) => void;
		/** The outline not yet accepted; `null` when there is none. */
		onproposal?: (tributary: AreaGeometry | null) => void;
	} = $props();

	type Status = 'idle' | 'working' | 'proposed' | 'refused';
	let status = $state<Status>('idle');
	let answer = $state.raw<DelineateAnswer | undefined>();
	let click = $state.raw<Click | undefined>();
	let message = $state('');
	let larger = $state.raw<LargerChannel | undefined>();
	let channelState = $state<'loading' | 'loaded' | 'none' | 'failed'>('loading');
	let channelError = $state('');
	let controller: AbortController | undefined;
	let panel = $state<HTMLElement | undefined>();

	function clear() {
		controller?.abort();
		controller = undefined;
		answer = undefined;
		click = undefined;
		message = '';
		larger = undefined;
		status = 'idle';
		onproposal?.(null);
	}

	/** A click on the map. Replaces anything in hand, a request included. */
	export function point(lngLat: Click, keepPoint = false) {
		clear();
		void delineate(lngLat, keepPoint);
	}

	$effect(() => {
		if (mapClick) untrack(() => point(mapClick));
	});

	async function delineate(lngLat: Click, keepPoint: boolean) {
		click = lngLat;
		status = 'working';
		const run = new AbortController();
		controller = run;
		try {
			const result = await fetchDelineation(lngLat, within, { baseUrl, signal: run.signal, keepPoint });
			if (run.signal.aborted) return;
			answer = result;
			status = 'proposed';
			onproposal?.(result.tributary);
		} catch (error) {
			if (run.signal.aborted || (error as Error).name === 'AbortError') return;
			message = (error as Error).message;
			larger = error instanceof TributaryRequestError ? error.larger : undefined;
			status = 'refused';
		}
		await tick();
		panel?.querySelector<HTMLElement>('[data-focus]')?.focus();
	}

	function accept() {
		if (!answer || !click) return;
		onresult(answer, click);
		clear();
	}

	$effect(() => {
		const piece = within;
		const run = new AbortController();
		untrack(() => {
			clear();
			void loadChannels(piece, run.signal);
		});
		return () => {
			run.abort();
			controller?.abort();
		};
	});

	async function loadChannels(piece: AreaGeometry, signal: AbortSignal) {
		channelState = 'loading';
		channelError = '';
		onchannels?.(null);
		try {
			const all = await fetchChannelsOver(piece, { baseUrl, signal }, (soFar) => {
				if (!signal.aborted) onchannels?.(soFar);
			});
			if (!signal.aborted) channelState = all.features.length > 0 ? 'loaded' : 'none';
		} catch (error) {
			if (signal.aborted || (error as Error).name === 'AbortError') return;
			channelState = 'failed';
			channelError = (error as Error).message;
		}
	}

	const facts = $derived(answer ? proposalFacts(answer) : []);
	const provenance = $derived(answer ? demFacts(answer) : []);
	const pans = $derived(answer ? pansNote(answer) : '');
</script>

<div class="tributary" bind:this={panel} data-tool="tributary" data-status={status}>
	{#if channelState === 'loading'}
		<p class="note" role="status">Drawing the terrain channels…</p>
	{:else if channelState === 'failed'}
		<p class="error" role="alert">The terrain channels could not be drawn: {channelError}</p>
	{:else if channelState === 'none'}
		<p class="warn"><strong>Check:</strong> the elevation model has no terrain channels here, so this area can’t be split by a tributary.</p>
	{/if}

	{#if status === 'idle'}
		<p class="note">Click a terrain channel inside the area, at the point the tributary joins the river. The catchment draining to that point becomes one piece; the rest stays as the other.</p>
	{:else if status === 'working'}
		<div class="actions">
			<p class="note" role="status">Tracing the catchment…</p>
			<button type="button" onclick={clear}>Cancel</button>
		</div>
	{:else if status === 'refused'}
		<p class="error" role="alert" tabindex="-1" data-focus>{message}</p>
		<div class="actions">
			{#if larger}
				{@const channel = larger}
				<button type="button" class="primary" onclick={() => point(channel.at)}>{largerChannelOffer(channel)}</button>
				{#if click}
					{@const mine = click}
					<button type="button" onclick={() => point(mine, true)}>Keep my point</button>
				{/if}
			{/if}
			<button type="button" onclick={clear}>Try again</button>
		</div>
	{:else if answer}
		<dl class="facts" aria-label="The proposed tributary" data-facts="tributary">
			{#each facts as fact (fact.label)}
				<div><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
			{/each}
		</dl>
		{#if answer.warning}
			<p class="warn" role="alert"><strong>Check:</strong> {warningText(answer.warning)}</p>
		{/if}
		{#if pans}
			<p class="note">{pans}</p>
		{/if}
		<dl class="facts provenance" aria-label="Where the outline comes from" data-provenance="dem">
			{#each provenance as fact (fact.label)}
				<div><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
			{/each}
		</dl>
		{#if answer.dem.attribution}
			<p class="note" data-attribution>{answer.dem.attribution}</p>
		{/if}
		<div class="actions">
			<button type="button" class="primary" onclick={accept} data-focus>Accept this tributary</button>
			<button type="button" onclick={clear}>Try again</button>
		</div>
	{/if}
</div>
