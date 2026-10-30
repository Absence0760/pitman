/** Test fixtures for the land-use screen: invented fields and dams over the synthetic block, no real farm or dam. */

import type { AreaGeometry, CropField, DamCandidate, LandUseAnswer } from '@pitman/wrsm';

export const box = (west: number, south: number, east: number, north: number): AreaGeometry => ({
	type: 'Polygon',
	coordinates: [
		[
			[west, south],
			[east, south],
			[east, north],
			[west, north],
			[west, south]
		]
	]
});

export const AREA = box(21, -33.75, 21.25, -33.5);

export const field = (id: string, crop: string, areaHa: number, irrigated: boolean | null): CropField => ({ id, crop, areaHa, irrigated, geometry: box(21.1, -33.6, 21.11, -33.59) });

const DAM: DamCandidate = { id: 'syn-reg-1', source: 'register', lon: 21.1, lat: -33.6, capacityMm3: 0.2, name: 'Synthetic dam 1' };

export const ANSWER: LandUseAnswer = {
	fields: [field('1', 'Wine grapes', 120, true), field('2', 'Wine grapes', 30, false), field('3', 'Lucerne', 80, null), field('4', 'Wheat', 400, false)],
	dams: [DAM],
	dataset: 'Synthetic crop census',
	surveyYear: 2023,
	fetchedOn: '2026-10-30',
	source: 'local'
};
