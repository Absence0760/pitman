import { describe, expect, it } from 'vitest';
import type { DelineateAnswer } from './api.js';
import { demFacts, largerChannelOffer, pansNote, proposalFacts, warningText } from './present.js';

const polygon = { type: 'Polygon', coordinates: [] } as const;
const answer = (over: Partial<DelineateAnswer> = {}): DelineateAnswer => ({
	tributary: polygon,
	remainder: polygon,
	tributaryKm2: 29.06,
	remainderKm2: 614.17,
	outsideKm2: 0,
	outsidePct: 0,
	warning: null,
	snapM: 87.6,
	pansKm2: 0,
	dem: { label: 'Synthetic DEM', fingerprint: 'abc123', zoom: 11, attribution: '' },
	...over
});

describe('proposalFacts', () => {
	it('gives the areas, the click’s move, and says when nothing was dropped', () => {
		expect(proposalFacts(answer())).toEqual([
			{ label: 'Tributary', value: '29.06 km²' },
			{ label: 'Remainder', value: '614.2 km²' },
			{ label: 'Outside the quaternary, dropped', value: 'None' },
			{ label: 'Click moved to the channel', value: '88 m' }
		]);
	});

	it('says what was dropped and its share of the catchment', () => {
		expect(proposalFacts(answer({ outsideKm2: 643.26, outsidePct: 89.34 }))[2]?.value).toBe('643.3 km² (89.3 % of the catchment)');
	});
});

describe('the rest of the wording', () => {
	it('names the elevation model', () => {
		expect(demFacts(answer())).toEqual([
			{ label: 'Elevation model', value: 'Synthetic DEM' },
			{ label: 'Version', value: 'abc123, zoom 11' }
		]);
	});

	it('mentions pans only when there are any', () => {
		expect(pansNote(answer())).toBe('');
		expect(pansNote(answer({ pansKm2: 2.5 }))).toMatch(/^2\.50 km² of the catchment drains into closed pans/);
	});

	it('capitalises the spec’s warning, and offers the larger channel with its area', () => {
		expect(warningText('most of this river’s catchment')).toBe('Most of this river’s catchment');
		expect(largerChannelOffer({ at: [21, -33], distanceM: 400, km2: 512.3, pointKm2: 2 })).toBe('Use that channel (512.3 km²)');
	});
});
