/**
 * Svelte action that draws a `ChartSpec` with uPlot. uPlot is loaded on
 * first use (it only runs in the browser), the chart follows the width of
 * its container through a ResizeObserver, and everything is torn down when
 * the element goes away. No logic lives here that a test needs: the data and
 * labels come from `charts.ts`.
 *
 * Series are told apart by line style as well as colour (WCAG 1.4.1): every
 * style slot has its own dash pattern, and observed flows are a heavier line
 * with markers on incomplete months.
 */

import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { xLabelOf, type ChartLine, type ChartSpec } from './charts.js';

/** Colour and dash per style slot; observed is the dark, solid, heavier line. */
export const LINE_STYLES: readonly { stroke: string; dash: number[] }[] = [
	{ stroke: '#1d5fbf', dash: [] },
	{ stroke: '#b3401d', dash: [8, 4] },
	{ stroke: '#2b7a4b', dash: [2, 3] },
	{ stroke: '#7a3fa0', dash: [12, 3, 2, 3] }
];
export const OBSERVED_STYLE = { stroke: '#1a1a1a', dash: [] as number[] };

export function styleOf(line: Pick<ChartLine, 'style'>): { stroke: string; dash: number[] } {
	return line.style === 'observed' ? OBSERVED_STYLE : (LINE_STYLES[line.style % LINE_STYLES.length] ?? OBSERVED_STYLE);
}

const HEIGHT = 280;

function options(U: typeof uPlot, spec: ChartSpec, width: number): uPlot.Options {
	const n = spec.lines.length;
	const barWidth = 0.8 / Math.max(n, 1);
	const series: uPlot.Series[] = [
		{ label: spec.xLabel, value: (_u, v) => (v === null ? '—' : xLabelOf(spec.xKind, v)) },
		...spec.lines.map((line, i): uPlot.Series => {
			const { stroke, dash } = styleOf(line);
			const observed = line.style === 'observed';
			const base: uPlot.Series = {
				label: line.label,
				stroke,
				dash,
				width: observed ? 2 : 1.5,
				spanGaps: spec.spanGaps,
				value: (_u, v) => (v === null ? '—' : v.toFixed(2))
			};
			if (spec.bars) {
				const x0 = spec.x.map((k) => k - 0.4 + i * barWidth);
				return {
					...base,
					fill: `${stroke}55`,
					paths: U.paths.bars?.({
						align: 1,
						disp: {
							x0: { unit: 1, values: () => x0 },
							size: { unit: 1, values: () => spec.x.map(() => barWidth) }
						}
					}),
					points: { show: false }
				};
			}
			if (line.marks !== undefined && line.marks.some(Boolean)) {
				const marks = line.marks;
				return { ...base, points: { show: true, size: 6, filter: (_u, _s, show) => (show ? marks.flatMap((m, j) => (m ? [j] : [])) : null) } };
			}
			return { ...base, points: { show: false } };
		})
	];
	return {
		width,
		height: HEIGHT,
		series,
		scales: {
			x: spec.bars ? { time: false, range: [-0.5, spec.x.length - 0.5] } : { time: false },
			y: spec.yLog ? { distr: 3 } : spec.bars ? { range: (_u, _min, max) => [0, max] } : {}
		},
		axes: [
			{
				label: spec.xLabel,
				values: (_u, ticks) => ticks.map((t) => (spec.bars && !Number.isInteger(t) ? '' : xLabelOf(spec.xKind === 'month' ? 'hydroYear' : spec.xKind, spec.xKind === 'month' ? Math.floor(t) : t)))
			},
			{ label: spec.yLabel, size: 60 }
		],
		legend: { show: true },
		cursor: { drag: { x: true, y: false } }
	};
}

function data(spec: ChartSpec): uPlot.AlignedData {
	return [spec.x as number[], ...spec.lines.map((l) => l.values as (number | null)[])];
}

/** `use:plot={spec}` on an empty element. */
export function plot(node: HTMLElement, initial: ChartSpec) {
	let spec = initial;
	let chart: uPlot | null = null;
	let U: typeof uPlot | null = null;
	let destroyed = false;

	const width = () => Math.max(node.clientWidth, 200);
	const draw = () => {
		if (U === null || destroyed) return;
		chart?.destroy();
		chart = new U(options(U, spec, width()), data(spec), node);
		// A real readiness signal for end-to-end tests: the chart is drawn.
		node.dataset['ready'] = 'true';
	};
	const observer = new ResizeObserver(() => chart?.setSize({ width: width(), height: HEIGHT }));
	observer.observe(node);
	void import('uplot').then((m) => {
		U = m.default;
		draw();
	});

	return {
		update(next: ChartSpec) {
			spec = next;
			draw();
		},
		destroy() {
			destroyed = true;
			observer.disconnect();
			chart?.destroy();
			chart = null;
		}
	};
}
