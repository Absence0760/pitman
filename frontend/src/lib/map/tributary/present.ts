/** What the tributary tool says: the facts of a proposal and the wording of its states, in plain language. */

import { formatNumber } from '#lib/results/format.js';
import type { DelineateAnswer, LargerChannel } from './api.js';

export interface Fact {
	readonly label: string;
	readonly value: string;
}

const km2 = (v: number) => `${formatNumber(v, v < 100 ? 2 : 1)} km²`;

/** The areas, what was dropped, and how far the click moved. */
export function proposalFacts(a: DelineateAnswer): Fact[] {
	return [
		{ label: 'Tributary', value: km2(a.tributaryKm2) },
		{ label: 'Remainder', value: km2(a.remainderKm2) },
		{ label: 'Outside the quaternary, dropped', value: a.outsideKm2 < 0.005 ? 'None' : `${km2(a.outsideKm2)} (${formatNumber(a.outsidePct, 1)} % of the catchment)` },
		{ label: 'Click moved to the channel', value: `${Math.round(a.snapM)} m` }
	];
}

/** Where the outline came from; the licence's notice goes with it (docs/data.md § DEM). */
export function demFacts(a: DelineateAnswer): Fact[] {
	return [
		{ label: 'Elevation model', value: a.dem.label },
		{ label: 'Version', value: `${a.dem.fingerprint}, zoom ${a.dem.zoom}` }
	];
}

/** The pans sentence, or nothing: reported only, the catchment stays gross (IC-WBT `pans.ts`). */
export function pansNote(a: DelineateAnswer): string {
	return a.pansKm2 < 0.005 ? '' : `${km2(a.pansKm2)} of the catchment drains into closed pans. It stays in the tributary; this is for your judgement.`;
}

/** The warning with its capital. */
export function warningText(warning: string): string {
	return warning.charAt(0).toUpperCase() + warning.slice(1);
}

/** The buttons' words for a `larger_channel` refusal. */
export function largerChannelOffer(larger: LargerChannel): string {
	return `Use that channel (${km2(larger.km2)})`;
}
