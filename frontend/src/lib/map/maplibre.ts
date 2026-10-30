// Ported from IC-WBT (Absence0760/project-water-management, MIT) frontend/src/lib/components/map/maplibre.ts at f888e4461.
//
// MapLibre, loaded only when a map is drawn: a dynamic import from Map.svelte,
// so the page's first load doesn't carry it. Its worker is a chunk of the page
// build (vite.config.ts), served from the app's own origin, so CSP
// `worker-src 'self'` holds without blob:.
import { AttributionControl, Map as MapLibreMap, Marker, NavigationControl, addProtocol, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './maplibre-theme.css';
import workerUrl from 'virtual:maplibre-worker-url';

setWorkerUrl(workerUrl);

let pmtiles: Promise<void> | null = null;
/** The `pmtiles://` protocol, registered once, and only when there is something to read (its own lazy chunk). */
export function usePmtiles(): Promise<void> {
	pmtiles ??= import('pmtiles').then(({ Protocol }) => {
		const protocol = new Protocol();
		addProtocol('pmtiles', protocol.tile);
	});
	return pmtiles;
}

export { AttributionControl, MapLibreMap, Marker, NavigationControl };
