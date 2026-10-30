<!--
	The map. Written for Pitman on the patterns of IC-WBT's CatchmentMap.svelte
	(Absence0760/project-water-management, MIT, frontend/src/lib/components/map/
	CatchmentMap.svelte at f888e4461): one effect per GeoJSON source, setStyle on
	a theme change, the focus handling.

	It takes `MapProps` (contract.ts) and nothing else: tools hand it data and
	react to its callbacks, so they never touch MapLibre. MapLibre is a dynamic
	import made when the map comes near the viewport, so it never weighs on the
	page's first load. The map is never the only way to do anything: a quaternary
	can be chosen by code, and a shape pasted. Without WebGL it says so. With no
	tiles it draws on a plain background and says that in a small note, not as
	an error (local-first). The canvas is focusable for MapLibre's keyboard pan
	and zoom; a crosshair marks the middle while it has the keyboard focus, and
	Enter acts there. Names of things are DOM, not map symbols: with no tiles
	there are no glyphs to write them with.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { MapProps } from './contract.js';
	import DrawBar from './draw/DrawBar.svelte';
	import { attachDrawing, type DrawMap } from './draw/attachDrawing.js';
	import { Draft } from './draw/draft.svelte.js';
	import { DRAFT_SOURCE, draftData } from './draw/drawLayers.js';
	import { snapLines } from './draw/snap.js';
	import {
		absoluteUrl,
		basemapLayerIds,
		channelData,
		mapGridData,
		mapGridLabelMinZoom,
		mapStyle,
		MAP_GRID_LABEL_LAYER,
		MAP_GRID_LAYER,
		moduleData,
		MODULE_LAYER,
		pieceData,
		proposalData,
		quaternaryData,
		QUATERNARY_HIT_LAYER,
		RELIEF_LAYER,
		TERRAIN_SOURCE
	} from './mapStyle.js';
	import { readPalette, type Palette } from './palette.js';
	import { boxOf, boxOfAll, interiorPoint, type Box } from './pieces.js';
	import { GLYPHS_URL, TERRAIN_URL, TILES_URL } from './tiles-base.js';

	let { quaternaries, selected, modules = [], pieces = [], channels = null, mapGrid = null, proposal = null, tool = 'select', onselect, onpoint, ondraw, onview }: MapProps = $props();

	type Lib = typeof import('./maplibre');
	type LiveMap = InstanceType<Lib['MapLibreMap']>;
	type Marker = InstanceType<Lib['Marker']>;

	/** South Africa, before there is anything to frame. */
	const SA: Box = [16.3, -35, 33, -22];
	/** The closest a frame goes. */
	const FRAME_MAX_ZOOM = 13;
	/** Below this zoom the codes would sit on each other; only the selected one stays. */
	const LABEL_MIN_ZOOM = 7;
	/** With more outlines than this, only the selected one is named: each name is a DOM node. */
	const LABEL_MAX = 200;

	let el = $state<HTMLDivElement>();
	let status = $state<'loading' | 'ready' | 'failed'>('loading');
	/** The view (west,south,east,north) after the last move: a settled-map signal for tests. */
	let view = $state('');
	let dark = $state(false);
	let palette: Palette | null = null;
	let lib: Lib | null = null;
	let map: LiveMap | null = null;
	let basemapFailed = $state(false);
	let reliefFailed = false;
	let zoomedOut = $state(false);
	/** What is under the pointer, in words. */
	let hover = $state<string | null>(null);
	/** The canvas has the keyboard focus: the crosshair shows. */
	let keyFocus = $state(false);
	/** Enter adds at the mouse pointer, not the crosshair: the crosshair hides. */
	let aimAtPointer = $state(false);

	const origin = typeof location === 'object' ? location.origin : '';
	const tilesUrl = absoluteUrl(TILES_URL, origin);
	const glyphsUrl = absoluteUrl(GLYPHS_URL, origin);
	const terrainUrl = absoluteUrl(TERRAIN_URL, origin);
	const noBasemap = $derived(!tilesUrl || basemapFailed);

	const draft = new Draft();
	const drawing = $derived(tool === 'draw');

	const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	function frame(b: Box, maxZoom = FRAME_MAX_ZOOM) {
		const instant = reduceMotion();
		map?.fitBounds(
			[
				[b[0], b[1]],
				[b[2], b[3]]
			],
			{ padding: 40, maxZoom, animate: !instant, duration: instant ? 0 : 500 }
		);
	}

	/** MapLibre posts source data to its worker, which can't clone a proxy; a parent may have held these in deep `$state`. */
	const plain = <T,>(v: T): T => $state.snapshot(v) as T;
	const draftView = () => (draft.active ? { coords: draft.coords, phase: draft.phase, whole: draft.whole, cursor: draft.cursor, corner: draft.corner, snap: draft.snapHint?.at ?? null } : null);
	const quaternariesNow = () => quaternaryData(plain(quaternaries?.features), selected);

	function styleNow(c: Palette) {
		return mapStyle(
			c,
			{ tilesUrl: basemapFailed ? null : tilesUrl, glyphs: glyphsUrl, terrain: reliefFailed ? null : terrainUrl, dark },
			{
				quaternaries: quaternariesNow(),
				channels: channelData(plain(channels)),
				pieces: pieceData(plain(pieces)),
				proposal: proposalData(plain(proposal)),
				modules: moduleData(modules),
				mapGrid: mapGridData(mapGrid),
				mapGridCellDeg: mapGrid?.cellDeg ?? null,
				draft: draftData(draftView())
			}
		);
	}

	/** Hand one GeoJSON source its data; MapLibre re-tiles the whole source in its worker, so only a source whose input changed is sent. */
	function setSource(id: string, data: () => unknown) {
		if (!map || status !== 'ready') return;
		(map.getSource(id) as { setData?: (d: unknown) => void } | undefined)?.setData?.(data());
	}

	// The quaternaries' codes: DOM, because with no tiles there are no glyphs.
	const labels = new globalThis.Map<string, { marker: Marker; el: HTMLSpanElement }>();
	function syncLabels() {
		if (!map || !lib) return;
		const features = quaternaries?.features ?? [];
		const shown = features.length > LABEL_MAX ? features.filter((f) => f.properties.code === selected) : features;
		const keep = new Set(shown.map((f) => f.properties.code));
		for (const [code, l] of labels) {
			if (keep.has(code)) continue;
			l.marker.remove();
			labels.delete(code);
		}
		for (const f of shown) {
			const code = f.properties.code;
			const had = labels.get(code);
			if (had) {
				had.el.dataset['selected'] = String(code === selected);
				continue;
			}
			const at = interiorPoint(f.geometry);
			if (!at) continue;
			const span = document.createElement('span');
			span.className = 'q-label';
			span.textContent = code;
			span.setAttribute('aria-hidden', 'true');
			span.dataset['selected'] = String(code === selected);
			labels.set(code, { marker: new lib.Marker({ element: span }).setLngLat([at[0], at[1]]).addTo(map), el: span });
		}
	}

	// The pieces' numbers: the number is what names a piece, so it is always drawn.
	const badges = new globalThis.Map<string, { marker: Marker; key: string }>();
	function syncBadges() {
		if (!map || !lib) return;
		const keep = new Set(pieces.map((p) => p.id));
		for (const [id, b] of badges) {
			if (keep.has(id)) continue;
			b.marker.remove();
			badges.delete(id);
		}
		for (const p of pieces) {
			const at = interiorPoint(p.geometry);
			if (!at) continue;
			const key = `${p.number}|${at.join(',')}`;
			const had = badges.get(p.id);
			if (had?.key === key) continue;
			had?.marker.remove();
			const span = document.createElement('span');
			span.className = 'piece-badge';
			span.textContent = String(p.number);
			span.title = p.label;
			span.setAttribute('aria-hidden', 'true');
			badges.set(p.id, { marker: new lib.Marker({ element: span }).setLngLat([at[0], at[1]]).addTo(map), key });
		}
	}

	function pickAt(point: { x: number; y: number }) {
		if (!map?.getLayer(QUATERNARY_HIT_LAYER)) return;
		const code = map.queryRenderedFeatures([point.x, point.y], { layers: [QUATERNARY_HIT_LAYER] })[0]?.properties?.['code'];
		if (typeof code === 'string') onselect?.(code);
	}

	function hoverAt(m: LiveMap, point: { x: number; y: number }) {
		const hits = m.queryRenderedFeatures([point.x, point.y], { layers: [MODULE_LAYER, MAP_GRID_LAYER, QUATERNARY_HIT_LAYER].filter((l) => m.getLayer(l)) });
		const moduleHit = hits.find((f) => f.layer.id === MODULE_LAYER)?.properties?.['label'];
		const code = hits.find((f) => f.layer.id === QUATERNARY_HIT_LAYER)?.properties?.['code'];
		const mm = hits.find((f) => f.layer.id === MAP_GRID_LAYER)?.properties?.['label'];
		hover = typeof moduleHit === 'string' ? moduleHit : [code, mm ? `MAP ${mm}` : undefined].filter(Boolean).join(' · ') || null;
		if (tool === 'select') m.getCanvas().style.cursor = code ? 'pointer' : '';
	}

	function start(node: HTMLDivElement) {
		let disposed = false;
		let stopTheme: (() => void) | null = null;
		(async () => {
			try {
				lib = await import('./maplibre');
				if (tilesUrl || terrainUrl) await lib.usePmtiles();
				if (disposed) return;
				const scheme = matchMedia('(prefers-color-scheme: dark)');
				dark = scheme.matches;
				palette = readPalette(node);
				const firstStyle = styleNow(palette);
				const box = (selected ? boxOf(quaternaries?.features.find((f) => f.properties.code === selected)?.geometry ?? { type: 'Polygon', coordinates: [] }) : null) ?? boxOfAll((quaternaries?.features ?? []).map((f) => f.geometry)) ?? SA;
				const m = new lib.MapLibreMap({
					container: node,
					// Plain objects matching the style spec (mapStyle.ts keeps MapLibre out of the first load).
					style: firstStyle as never,
					attributionControl: false,
					bounds: [
						[box[0], box[1]],
						[box[2], box[3]]
					],
					fitBoundsOptions: { padding: 40, maxZoom: FRAME_MAX_ZOOM },
					keyboard: true,
					// One long page: a wheel or a finger scrolls the page unless the user means the map (ctrl + wheel, two fingers).
					cooperativeGestures: true,
					dragRotate: false,
					pitchWithRotate: false,
					touchPitch: false
				});
				map = m;
				m.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
				// Always expanded: the basemap's and the relief's licences ask to stay visible.
				m.addControl(new lib.AttributionControl({ compact: false }), 'bottom-right');
				m.on('error', (ev) => {
					const e = ev as unknown as { sourceId?: string; error?: { message?: string } };
					if (e.sourceId === 'basemap' && !basemapFailed) {
						basemapFailed = true;
						for (const id of basemapLayerIds(firstStyle)) if (m.getLayer(id)) m.removeLayer(id);
					} else if (e.sourceId === TERRAIN_SOURCE && !reliefFailed) {
						reliefFailed = true;
						if (m.getLayer(RELIEF_LAYER)) m.removeLayer(RELIEF_LAYER);
					} else if (/webgl/i.test(e.error?.message ?? '')) {
						status = 'failed';
					}
				});
				// The theme flipped: the same data in the new colours (the style carries the current sources).
				const onScheme = () => {
					dark = scheme.matches;
					palette = readPalette(node);
					m.setStyle(styleNow(palette) as never);
				};
				scheme.addEventListener('change', onScheme);
				stopTheme = () => scheme.removeEventListener('change', onScheme);
				const reportView = () => {
					const b = m.getBounds();
					const v: Box = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
					view = v.map((x) => x.toFixed(4)).join(',');
					onview?.(v);
				};
				m.on('moveend', reportView);
				m.on('zoom', () => (zoomedOut = m.getZoom() < LABEL_MIN_ZOOM));
				m.on('load', () => {
					zoomedOut = m.getZoom() < LABEL_MIN_ZOOM;
					reportView();
					m.on('click', (e: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } }) => {
						if (tool === 'point') onpoint?.([e.lngLat.lng, e.lngLat.lat]);
						else if (tool === 'select') pickAt(e.point);
					});
					m.on('mousemove', (e: { point: { x: number; y: number } }) => {
						if (tool === 'draw') hover = null;
						else hoverAt(m, e.point);
					});
					m.on('mouseout', () => (hover = null));
					const canvas = m.getCanvas();
					// The crosshair is for the keyboard: shown when the focus came by keyboard, not after a click.
					canvas.addEventListener('focus', () => (keyFocus = canvas.matches(':focus-visible')));
					canvas.addEventListener('keydown', () => (keyFocus = true));
					canvas.addEventListener('blur', () => (keyFocus = false));
					// Enter acts at the crosshair; drawing has its own keys (attachDrawing.ts).
					canvas.addEventListener('keydown', (e) => {
						if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey || tool === 'draw') return;
						const c = m.getCenter();
						if (tool === 'point') onpoint?.([c.lng, c.lat]);
						else pickAt(m.project(c));
					});
					status = 'ready';
				});
			} catch {
				// No WebGL (a locked-down browser): the panel's list does what the map does.
				if (!disposed) status = 'failed';
			}
		})();
		return () => {
			disposed = true;
			stopTheme?.();
			for (const l of labels.values()) l.marker.remove();
			labels.clear();
			for (const b of badges.values()) b.marker.remove();
			badges.clear();
			map?.remove();
			map = null;
		};
	}

	onMount(() => {
		const node = el;
		if (!node) return;
		// Every section stays mounted on the one page: don't load MapLibre until the map is near the view.
		if (typeof IntersectionObserver !== 'function') return start(node);
		let stop: (() => void) | undefined;
		const seen = new IntersectionObserver(
			(entries) => {
				if (!entries.some((e) => e.isIntersecting) || stop) return;
				seen.disconnect();
				stop = start(node);
			},
			{ rootMargin: '300px' }
		);
		seen.observe(node);
		return () => {
			seen.disconnect();
			stop?.();
		};
	});

	// One effect per source: a new selection must not re-send every piece and grid cell to the worker.
	$effect(() => {
		const data = quaternariesNow();
		setSource('quaternaries', () => data);
		if (status === 'ready') untrack(syncLabels);
	});
	$effect(() => {
		const data = channelData(plain(channels));
		setSource('channels', () => data);
	});
	$effect(() => {
		const data = pieceData(plain(pieces));
		setSource('pieces', () => data);
		if (status === 'ready') untrack(syncBadges);
	});
	$effect(() => {
		const data = proposalData(plain(proposal));
		setSource('proposal', () => data);
	});
	$effect(() => {
		const data = moduleData(modules);
		setSource('modules', () => data);
	});
	$effect(() => {
		const data = mapGridData(mapGrid);
		setSource('mapgrid', () => data);
		if (status === 'ready' && map?.getLayer(MAP_GRID_LABEL_LAYER)) map.setLayerZoomRange(MAP_GRID_LABEL_LAYER, mapGridLabelMinZoom(mapGrid?.cellDeg), 24);
	});
	$effect(() => {
		const data = draftData(draftView());
		setSource(DRAFT_SOURCE, () => data);
	});

	// The first boundaries are framed, then each new selection (instantly under prefers-reduced-motion).
	let framedAll = false;
	let framedCode: string | null = null;
	$effect(() => {
		const features = quaternaries?.features;
		const code = selected;
		if (status !== 'ready' || !features?.length) return;
		const picked = code ? features.find((f) => f.properties.code === code) : undefined;
		if (picked && code !== framedCode) {
			framedCode = code;
			framedAll = true;
			const b = boxOf(picked.geometry);
			if (b) untrack(() => frame(b));
		} else if (!framedAll) {
			framedAll = true;
			const b = boxOfAll(features.map((f) => f.geometry));
			if (b) untrack(() => frame(b));
		}
		if (!code) framedCode = null;
	});

	// Drawing mode follows the tool; without a map the bar still takes a pasted shape.
	$effect(() => {
		const on = drawing;
		untrack(() => {
			if (on && !draft.active) draft.start();
			else if (!on && draft.active) draft.stop();
		});
	});
	$effect(() => {
		const outlines = (quaternaries?.features ?? []).map((f) => ({ id: f.properties.code, label: f.properties.code, geometry: f.geometry }));
		draft.snapTargets = snapLines(plain([...outlines, ...pieces.map((p) => ({ id: p.id, label: `piece ${p.number}`, geometry: p.geometry }))]));
	});
	$effect(() => {
		const node = el;
		if (status !== 'ready' || !drawing || !map || !node) return;
		const m = map;
		return untrack(() => attachDrawing(m as unknown as DrawMap, draft, node, (p) => (aimAtPointer = p)));
	});
	$effect(() => {
		const canvas = status === 'ready' && !drawing ? map?.getCanvas() : undefined;
		if (canvas) canvas.style.cursor = tool === 'point' ? 'crosshair' : '';
	});

	const keysHelp = $derived.by(() => {
		const name = selected ? `Map of the quaternaries, ${selected} selected` : 'Map of the quaternaries';
		if (tool === 'draw') {
			return draft.phase === 'drawing'
				? `${name}, drawing: the arrow keys move the map under the crosshair, Enter adds a corner there, Alt+Enter without snapping, Backspace removes the last, Escape clears`
				: `${name}, adjusting the drawing: the arrow keys pan, Escape clears; pick a corner on the map to remove it with Delete`;
		}
		if (tool === 'point') return `${name}: the arrow keys move the map under the crosshair, Enter picks the point there`;
		return `${name}: the arrow keys pan, + and − zoom, Enter selects the quaternary under the crosshair`;
	});
	$effect(() => {
		const help = keysHelp;
		if (status === 'ready') map?.getCanvas().setAttribute('aria-label', help);
	});

	const crosshair = $derived(status === 'ready' && keyFocus && !aimAtPointer && (tool !== 'select' || !!quaternaries));
	const chip = $derived(hover ?? (selected ? `Selected: ${selected}` : null));
</script>

<div class="map-wrap" class:labels-off={zoomedOut} data-status={status} data-view={view || undefined} data-tool={tool} data-theme-drawn={dark ? 'dark' : 'light'}>
	<div class="map" role="region" aria-label="Map" bind:this={el} data-testid="map">
		{#if crosshair}
			<!-- Where Enter acts: the map's middle; the arrow keys move the map under it. -->
			<span class="crosshair" aria-hidden="true" data-testid="map-crosshair"></span>
		{/if}
	</div>
	{#if status === 'ready' && chip && tool !== 'draw'}
		<!-- For the eye: the canvas's name says the selection, and the panel's list and tiles say everything here. -->
		<p class="chip" aria-hidden="true" data-testid="map-chip">{chip}</p>
	{/if}
	{#if status === 'loading'}
		<p class="state note" role="status">Drawing the map…</p>
	{:else if status === 'failed'}
		<p class="state warn" role="status" data-testid="map-unavailable">The map can’t be drawn in this browser (it needs WebGL). Everything else on this page works without it.</p>
	{/if}
	{#if status === 'ready' && noBasemap}
		<p class="note basemap-note" data-testid="map-basemap-note">No basemap here: everything is drawn on a plain background.</p>
	{/if}
	{#if drawing}
		<DrawBar
			{draft}
			mapReady={status === 'ready'}
			onuse={(g) => {
				ondraw?.(plain(g));
				draft.start();
			}}
		/>
	{/if}
</div>

<style>
	.map-wrap {
		position: relative;
	}
	.map {
		height: min(60vh, 560px);
		min-height: 320px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
		background: var(--map-bg);
	}
	@media (max-width: 40rem) {
		.map {
			height: 50vh;
			min-height: 240px;
		}
	}
	.map :global(.maplibregl-canvas:focus-visible) {
		outline: 3px solid var(--focus);
		outline-offset: -3px;
	}
	.crosshair {
		position: absolute;
		z-index: 2;
		left: 50%;
		top: 50%;
		width: 28px;
		height: 28px;
		margin: -14px 0 0 -14px;
		pointer-events: none;
		background:
			linear-gradient(var(--map-selected), var(--map-selected)) center / 3px 100% no-repeat,
			linear-gradient(var(--map-selected), var(--map-selected)) center / 100% 3px no-repeat;
		filter: drop-shadow(0 0 1px var(--map-casing)) drop-shadow(0 0 1px var(--map-casing));
	}
	.chip {
		position: absolute;
		z-index: 2;
		left: 0.5rem;
		top: 0.5rem;
		max-width: calc(100% - 4rem);
		margin: 0;
		padding: 0.15rem 0.5rem;
		pointer-events: none;
		font-size: var(--font-sm);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
	}
	.state {
		position: absolute;
		z-index: 2;
		inset: 0.75rem 0.75rem auto;
		margin: 0;
	}
	.basemap-note {
		margin: 0.35rem 0 0;
		font-size: var(--font-xs);
	}
	/* A code is a label, never a target: a click goes through to the quaternary under it. */
	.map :global(.q-label) {
		pointer-events: none;
		font-size: var(--font-xs);
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		color: var(--map-label);
		text-shadow:
			0 0 2px var(--map-halo),
			0 0 2px var(--map-halo),
			0 0 3px var(--map-halo);
	}
	.map :global(.q-label[data-selected='true']) {
		color: var(--map-selected);
		font-size: var(--font-sm);
	}
	.labels-off .map :global(.q-label[data-selected='false']) {
		display: none;
	}
	/* 24 px or more across (WCAG 2.5.8 for its piece's name), with a casing so it reads on any tint. */
	.map :global(.piece-badge) {
		pointer-events: none;
		display: grid;
		place-items: center;
		min-width: 1.6rem;
		height: 1.6rem;
		padding: 0 0.3rem;
		border-radius: 999px;
		font-size: var(--font-sm);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		background: var(--surface);
		border: 2px solid var(--map-selected);
	}
</style>
