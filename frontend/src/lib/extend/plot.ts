/**
 * Svelte action that draws an `ExtendChartSpec` with uPlot, following
 * `#lib/results/plot.ts` (load uPlot on first use, follow the container's
 * width, tear down with the element, `data-ready` once drawn) and reusing
 * its line styles. It adds what the fit diagnostics need and the results
 * charts don't: scatter points, a shaded x band and a note above each x.
 */

import type uPlot from 'uplot';
import { axisStyle, LINE_STYLES, onThemeChange, tokenColour } from '#lib/results/plot.js';
import { HYDRO_MONTHS, hydroYearLabel } from '#lib/results/format.js';
import type { ExtendChartSpec, ExtendSeries } from './charts.js';

/** One colour per calendar month (October first) for the scatter; the data table and the month filter carry the same split without colour. */
export const MONTH_COLOURS = Array.from({ length: 12 }, (_, i) => `var(--series-${i + 1})`);

/** Colour and dash per series style; the three fit series reuse the results charts' first three slots. */
export function seriesStyle(s: Pick<ExtendSeries, 'style'>): { stroke: string; dash: number[] } {
	switch (s.style) {
		case 'model':
			return LINE_STYLES[0] ?? { stroke: 'var(--series-1)', dash: [] };
		case 'chirps':
			return LINE_STYLES[1] ?? { stroke: 'var(--series-2)', dash: [8, 4] };
		case 'corrected':
			return LINE_STYLES[2] ?? { stroke: 'var(--series-3)', dash: [2, 3] };
		case 'oneToOne':
			return { stroke: 'var(--series-neutral)', dash: [6, 4] };
		default:
			return { stroke: MONTH_COLOURS[s.style % 12] ?? 'var(--series-1)', dash: [] };
	}
}

const HEIGHT = 300;

function tick(spec: ExtendChartSpec, t: number): string {
	if (spec.xKind === 'monthOfYear') return Number.isInteger(t) ? (HYDRO_MONTHS[t] ?? '') : '';
	if (spec.xKind === 'hydroYear') return Number.isInteger(t) ? hydroYearLabel(t) : '';
	return String(Math.round(t * 100) / 100);
}

function options(U: typeof uPlot, spec: ExtendChartSpec, width: number, node: Element): uPlot.Options {
	const ink = tokenColour(node, 'var(--text)');
	const bars = spec.series.filter((s) => s.mark === 'bars');
	const barWidth = 0.8 / Math.max(bars.length, 1);
	const series: uPlot.Series[] = [
		{ label: spec.xLabel, value: (_u, v) => (v === null ? '—' : tick(spec, v)) },
		...spec.series.map((s): uPlot.Series => {
			const { dash } = seriesStyle(s);
			const stroke = tokenColour(node, seriesStyle(s).stroke);
			const base: uPlot.Series = { label: s.label, stroke, dash, width: 1.5, spanGaps: s.style === 'oneToOne', value: (_u, v) => (v === null ? '—' : v.toFixed(2)) };
			if (s.mark === 'points') return { ...base, paths: () => null, points: { show: true, size: 6, fill: stroke, stroke } };
			if (s.mark === 'bars') {
				const slot = bars.indexOf(s);
				const x0 = spec.x.map((k) => k - 0.4 + slot * barWidth);
				return {
					...base,
					fill: `${stroke}66`,
					paths: U.paths.bars?.({ align: 1, disp: { x0: { unit: 1, values: () => x0 }, size: { unit: 1, values: () => spec.x.map(() => barWidth) } } }),
					points: { show: false }
				};
			}
			return { ...base, points: { show: false } };
		})
	];
	const hooks: uPlot.Hooks.Arrays = {};
	if (spec.bands.length > 0) {
		hooks.drawClear = [
			(u) => {
				const ctx = u.ctx;
				ctx.save();
				ctx.fillStyle = 'rgba(128, 128, 128, 0.18)';
				for (const band of spec.bands) {
					const left = u.valToPos(band.from, 'x', true);
					const right = u.valToPos(band.to, 'x', true);
					ctx.fillRect(left, u.bbox.top, right - left, u.bbox.height);
				}
				ctx.restore();
			}
		];
	}
	if (spec.xNotes) {
		const notes = spec.xNotes;
		hooks.draw = [
			(u) => {
				const ctx = u.ctx;
				ctx.save();
				ctx.fillStyle = ink;
				ctx.textAlign = 'center';
				ctx.font = `${Math.round(10 * devicePixelRatio)}px system-ui, sans-serif`;
				spec.x.forEach((x, i) => {
					const top = Math.max(...bars.map((s) => s.values[i] ?? 0));
					ctx.fillText(notes[i] ?? '', u.valToPos(x, 'x', true), u.valToPos(top, 'y', true) - 4 * devicePixelRatio);
				});
				ctx.restore();
			}
		];
	}
	const xRange: uPlot.Scale = bars.length > 0 ? { time: false, range: [-0.5, spec.x.length - 0.5] } : { time: false };
	return {
		width,
		height: HEIGHT,
		series,
		scales: {
			x: xRange,
			// Bars start at 0 and leave room for the note above the tallest; percentages never go below 0.
			y: { range: (_u, _min, max) => [0, (max || 1) * (spec.xNotes ? 1.15 : 1.05)] }
		},
		axes: [
			{ ...axisStyle(node), label: spec.xLabel, values: (_u, ticks) => ticks.map((t) => tick(spec, t)) },
			{ ...axisStyle(node), label: spec.yLabel, size: 60 }
		],
		legend: { show: true },
		cursor: { drag: { x: true, y: false } },
		hooks
	};
}

function data(spec: ExtendChartSpec): uPlot.AlignedData {
	return [spec.x as number[], ...spec.series.map((s) => s.values as (number | null)[])];
}

/** `use:extendPlot={spec}` on an empty element. */
export function extendPlot(node: HTMLElement, initial: ExtendChartSpec) {
	let spec = initial;
	let chart: uPlot | null = null;
	let U: typeof uPlot | null = null;
	let destroyed = false;

	const width = () => Math.max(node.clientWidth, 200);
	const draw = () => {
		if (U === null || destroyed) return;
		chart?.destroy();
		node.dataset['ready'] = 'false';
		chart = new U(options(U, spec, width(), node), data(spec), node);
		// A real readiness signal for end-to-end tests: the chart is drawn.
		node.dataset['ready'] = 'true';
	};
	const observer = new ResizeObserver(() => chart?.setSize({ width: width(), height: HEIGHT }));
	observer.observe(node);
	const stopTheme = onThemeChange(draw);
	void import('uplot').then((m) => {
		U = m.default;
		draw();
	});

	return {
		update(next: ExtendChartSpec) {
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
}
