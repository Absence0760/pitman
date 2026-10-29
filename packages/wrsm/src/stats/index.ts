/** Flow statistics and the gauge comparison (docs/theory/statistics.md). */

export {
	annualTotals,
	flowDuration,
	flowStatistics,
	meanMonthly,
	rowsInPeriod,
	seasonalIndex,
	seriesRows,
	type DurationPoint,
	type FlowStatistics,
	type FlowStatisticsOptions,
	type LogBase
} from './flow.js';
export {
	WR2012_FIT_GUIDELINES,
	WR2012_STATISTICS,
	gaugeStatistics,
	observedOnSeries,
	pairAtGauge,
	percentError,
	type GaugePairing,
	type GaugeStatistics,
	type PairedMonth,
	type PairingOptions,
	type StatisticComparison,
	type Wr2012Statistic
} from './gauge.js';
