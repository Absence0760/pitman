/**
 * Svelte action that draws a `SeriesChartSpec` with uPlot, on the life of
 * `#lib/results/plot.ts`. It adds the marks: round dots at listed years, hollow
 * diamonds at edited ones, drawn on the canvas because uPlot's points have one
 * shape.
 */

import type uPlot from 'uplot';
import { axisStyle, axisTitle, LINE_STYLES, tokenColour, uPlotAction } from '#lib/results/plot.js';
import { X_LABEL, type SeriesChartSpec } from './chart.js';
import { formatCell } from './review.js';

export const FILE_STYLE = { stroke: LINE_STYLES[0]?.stroke ?? 'var(--series-1)', dash: [] as number[] };
export const EDITED_STYLE = { stroke: LINE_STYLES[1]?.stroke ?? 'var(--series-2)', dash: [8, 4] };

const HEIGHT = 240;

function options(spec: SeriesChartSpec, width: number, node: Element): uPlot.Options {
	const fileStroke = tokenColour(node, FILE_STYLE.stroke);
	const editedStroke = tokenColour(node, EDITED_STYLE.stroke);
	const ground = tokenColour(node, 'var(--surface)');
	const reading = (_u: uPlot, v: number | null) => (v === null ? '—' : formatCell(spec.table, v));
	return {
		width,
		height: HEIGHT,
		series: [
			{ label: X_LABEL, value: (_u, v) => (v === null ? '—' : String(v)) },
			{ label: 'In the network file', stroke: fileStroke, dash: FILE_STYLE.dash, width: 1.5, points: { show: false }, value: reading },
			...(spec.edited ? [{ label: 'With your edits', stroke: editedStroke, dash: EDITED_STYLE.dash, width: 2, points: { show: false }, value: reading }] : [])
		],
		scales: { x: { time: false }, y: { range: (_u, _min, max) => [0, (max || 1) * 1.1] } },
		axes: [
			{ ...axisStyle(node), label: axisTitle(X_LABEL, width), values: (_u, ticks) => ticks.map((t) => (Number.isInteger(t) ? String(t) : '')) },
			{ ...axisStyle(node), label: spec.yLabel, size: 60 }
		],
		legend: { show: true },
		cursor: { drag: { x: true, y: false } },
		hooks: {
			draw: [
				(u) => {
					const ctx = u.ctx;
					const unit = devicePixelRatio;
					ctx.save();
					ctx.lineWidth = 2 * unit;
					ctx.fillStyle = fileStroke;
					spec.fileMarks.forEach((v, i) => {
						if (v === null) return;
						ctx.beginPath();
						ctx.arc(u.valToPos(spec.x[i] ?? 0, 'x', true), u.valToPos(v, 'y', true), 3 * unit, 0, 2 * Math.PI);
						ctx.fill();
					});
					ctx.strokeStyle = editedStroke;
					ctx.fillStyle = ground;
					const r = 6 * unit;
					spec.editedMarks.forEach((v, i) => {
						if (v === null) return;
						const x = u.valToPos(spec.x[i] ?? 0, 'x', true);
						const y = u.valToPos(v, 'y', true);
						ctx.beginPath();
						ctx.moveTo(x, y - r);
						ctx.lineTo(x + r, y);
						ctx.lineTo(x, y + r);
						ctx.lineTo(x - r, y);
						ctx.closePath();
						ctx.fill();
						ctx.stroke();
					});
					ctx.restore();
				}
			]
		}
	};
}

function data(spec: SeriesChartSpec): uPlot.AlignedData {
	return [spec.x as number[], spec.file as number[], ...(spec.edited ? [spec.edited as number[]] : [])];
}

/** `use:seriesPlot={spec}` on an empty element. */
export const seriesPlot = uPlotAction<SeriesChartSpec>(HEIGHT, (_U, spec, width, node) => ({ options: options(spec, width, node), data: data(spec) }));
