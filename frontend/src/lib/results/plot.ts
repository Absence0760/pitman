/**
 * Svelte action that draws a `ChartSpec` with uPlot, and the life every chart
 * on the page shares (`uPlotAction`): the extension's fit and the land-use
 * series use it too, and `e2e/charts.spec.ts` holds all three to it. No logic
 * lives here that a test needs: the data and labels come from `charts.ts`.
 *
 * Line series are told apart by style as well as colour (WCAG 1.4.1): every
 * style slot has its own dash pattern, and observed flows are a heavier line
 * with markers on incomplete months. Bars can't take a dash (it reads as
 * hatching at their width): their place in each group, in the key's order,
 * is the second cue.
 */

import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { xLabelOf, type ChartLine, type ChartSpec } from './charts.js';

/** Colour and dash per style slot; observed is the dark, solid, heavier line. */
export const LINE_STYLES: readonly { stroke: string; dash: number[] }[] = [
	{ stroke: 'var(--series-1)', dash: [] },
	{ stroke: 'var(--series-2)', dash: [8, 4] },
	{ stroke: 'var(--series-3)', dash: [2, 3] },
	{ stroke: 'var(--series-4)', dash: [12, 3, 2, 3] }
];
export const OBSERVED_STYLE = { stroke: 'var(--series-observed)', dash: [] as number[] };

/** What a colour token holds on `node`: a canvas can't read `var()`, the key's svg can. */
export function tokenColour(node: Element, colour: string): string {
	const token = /^var\((--[a-z0-9-]+)\)$/.exec(colour)?.[1];
	return token === undefined ? colour : getComputedStyle(node).getPropertyValue(token).trim();
}

/** The axes and grid, from the theme: uPlot's defaults are black, unreadable in the dark theme. */
export function axisStyle(node: Element): Pick<uPlot.Axis, 'stroke' | 'grid' | 'ticks'> {
	const line = { stroke: tokenColour(node, 'var(--border)'), width: 1 };
	return { stroke: tokenColour(node, 'var(--text-muted)'), grid: line, ticks: line };
}

/** Below this width a long axis title runs off the chart; the figure's caption says both axes anyway. */
const NARROW_CHART = 480;

export function axisTitle(label: string, width: number): string | undefined {
	return width < NARROW_CHART ? undefined : label;
}

/** Whether a resize from `from` to `to` crosses into a layout `setSize` can't reach, so the chart must be rebuilt. */
export function crossesNarrow(from: number, to: number): boolean {
	return from < NARROW_CHART !== to < NARROW_CHART;
}

/** Run `redraw` when the theme flips under a drawn chart; returns the way to stop. */
export function onThemeChange(redraw: () => void): () => void {
	const scheme = matchMedia('(prefers-color-scheme: dark)');
	scheme.addEventListener('change', redraw);
	return () => scheme.removeEventListener('change', redraw);
}

export function styleOf(line: Pick<ChartLine, 'style'>): { stroke: string; dash: number[] } {
	return line.style === 'observed' ? OBSERVED_STYLE : (LINE_STYLES[line.style % LINE_STYLES.length] ?? OBSERVED_STYLE);
}

const HEIGHT = 280;

function options(U: typeof uPlot, spec: ChartSpec, width: number, node: Element): uPlot.Options {
	const n = spec.lines.length;
	const barWidth = 0.8 / Math.max(n, 1);
	const series: uPlot.Series[] = [
		{ label: spec.xLabel, value: (_u, v) => (v === null ? '—' : xLabelOf(spec.xKind, v)) },
		...spec.lines.map((line, i): uPlot.Series => {
			const { dash } = styleOf(line);
			const stroke = tokenColour(node, styleOf(line).stroke);
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
					dash: [],
					fill: `${stroke}88`,
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
				...axisStyle(node),
				label: axisTitle(spec.xLabel, width),
				values: (_u, ticks) => ticks.map((t) => (spec.bars && !Number.isInteger(t) ? '' : xLabelOf(spec.xKind === 'month' ? 'hydroYear' : spec.xKind, spec.xKind === 'month' ? Math.floor(t) : t)))
			},
			{ ...axisStyle(node), label: spec.yLabel, size: 60 }
		],
		legend: { show: true },
		cursor: { drag: { x: true, y: false } }
	};
}

function data(spec: ChartSpec): uPlot.AlignedData {
	return [spec.x as number[], ...spec.lines.map((l) => l.values as (number | null)[])];
}

/** What one chart draws: uPlot's options and data for a spec at a width. */
export type ChartBuild<Spec> = (U: typeof uPlot, spec: Spec, width: number, node: HTMLElement) => { options: uPlot.Options; data: uPlot.AlignedData };

/**
 * The Svelte action for a kind of chart, on an empty element. All three chart
 * screens share this life: uPlot loads on first use, the chart follows its
 * box's width and is rebuilt when it crosses `NARROW_CHART`, a theme flip or a
 * new spec redraws it, and it is torn down with the element.
 */
export function uPlotAction<Spec>(height: number, build: ChartBuild<Spec>) {
	return (node: HTMLElement, initial: Spec) => {
		let spec = initial;
		let chart: uPlot | null = null;
		let U: typeof uPlot | null = null;
		let destroyed = false;
		let drawnWidth = 0;

		const width = () => Math.max(node.clientWidth, 200);
		const draw = () => {
			if (U === null || destroyed) return;
			chart?.destroy();
			node.dataset['ready'] = 'false';
			const { options, data } = build(U, spec, width(), node);
			chart = new U(options, data, node);
			drawnWidth = width();
			// A real readiness signal for end-to-end tests: the chart is drawn.
			node.dataset['ready'] = 'true';
		};
		const observer = new ResizeObserver(() => {
			if (crossesNarrow(drawnWidth, width())) draw();
			else chart?.setSize({ width: width(), height });
			drawnWidth = width();
		});
		observer.observe(node);
		const stopTheme = onThemeChange(draw);
		void import('uplot').then((m) => {
			U = m.default;
			draw();
		});

		return {
			update(next: Spec) {
				spec = next;
				draw();
			},
			destroy() {
				destroyed = true;
				observer.disconnect();
				stopTheme();
				chart?.destroy();
				chart = null;
			}
		};
	};
}

/** `use:plot={spec}` on an empty element. */
export const plot = uPlotAction<ChartSpec>(HEIGHT, (U, spec, width, node) => ({ options: options(U, spec, width, node), data: data(spec) }));
