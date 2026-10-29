/** Method A, the CHIRPS extension of a rainfall file (docs/theory/extend.md). The contract is exported from `./contract.js`. */

export {
	CHIRPS3_DOI,
	COAST_WARN_PCT,
	DRY_EPSILON_PCT,
	FACTOR_MAX,
	FACTOR_WARN_HIGH,
	FACTOR_WARN_LOW,
	FEW_CELLS,
	FEW_OVERLAP_YEARS,
	HYDRO_MONTHS,
	MIN_OVERLAP_YEARS,
	applyRainfallExtension,
	calendarMonth,
	checkFactor,
	estimateFactors,
	fitRainfallExtension,
	fitStatistics,
	hydroMonth,
	overlapYears,
	refitFromSidecar,
	roundHalfAwayFromZero,
	stripExtension,
	type OverlapYear
} from './rain.js';
export { syntheticChirpsMonthly, type SyntheticChirpsOptions } from './synthetic.js';
