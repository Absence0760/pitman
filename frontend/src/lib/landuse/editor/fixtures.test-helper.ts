import type { NetworkBundle, RunoffModule } from '@pitman/wrsm';
import { syntheticBundle } from '#lib/network/synthetic.js';

const SPECIES = { pine: { percent: 60, rotationYears: 20 }, eucalyptus: { percent: 40, rotationYears: 10 }, wattle: { percent: 0, rotationYears: 0 } };
const COMPOSITION = { tallTrees: { percent: 50, ageYears: 15 }, mediumTrees: { percent: 30, ageYears: 10 }, tallShrubs: { percent: 20, ageYears: 8 } };

/**
 * The synthetic network with invented land use: RU 1 a free module of 100 km²
 * with all three tables, RU 2 a parent of 50 km² and RU 3 its afforested child
 * of 10 km². Years 1980–2009 (`syntheticBundle`'s default period is shorter).
 */
export function landUseBundle(): NetworkBundle {
	const base = syntheticBundle({ startYear: 1980, years: 30 });
	const modules = base.modules.map((m) => {
		if (m.kind !== 'RU') return m;
		if (m.number === 1) {
			const free: RunoffModule = {
				...m,
				areaKm2: 100,
				afforestation: { ...m.afforestation, algorithm: 2, areaKm2: [{ year: 1990, value: 4.5 }, { year: 2004, value: 10 }], species: SPECIES, optimalPercent: 80 },
				alienVegetation: { algorithm: 1, riparianArea: 20, areaKm2: [{ year: 1995, value: 2 }], composition: COMPOSITION, optimalPercent: 70 },
				paved: { fraction: [{ year: 2000, value: 0.012 }] }
			};
			return free;
		}
		if (m.number === 2) return { ...m, areaKm2: 50, sfrChildren: [3] };
		if (m.number === 3) return { ...m, areaKm2: 10, afforestation: { ...m.afforestation, algorithm: 2 as const, areaKm2:[{ year: 1990, value: 3 }, { year: 2004, value: 8 }], species: SPECIES, optimalPercent: 80 } };
		return m;
	});
	return { ...base, modules };
}

export const runoff = (bundle: NetworkBundle, number: number) => bundle.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === number)!;

/** The bundle with one runoff module changed. */
export function withRunoff(bundle: NetworkBundle, number: number, change: (m: RunoffModule) => RunoffModule): NetworkBundle {
	return { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'RU' && m.number === number ? change(m) : m)) };
}
