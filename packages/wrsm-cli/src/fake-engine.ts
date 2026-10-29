import type { AnswerFile, AnswerRow, Monthly12, MonthlySeries, Network, RainfallSeries, RunoffModule } from '@pitman/wrsm';
import type { Engine } from './engine.js';

/**
 * A stand-in `Engine` for CLI tests (not used by the CLI itself). Every
 * "file" is the JSON of its typed object, so tests write synthetic objects
 * straight to disk. The runoff model is a fixed 10 % runoff coefficient:
 * flow (million m³) = rainfall % MAP / 100 × MAP mm × area km² × 1e-3 × 0.1.
 */
export const fakeEngine: Engine = {
	readNetwork: (text) => JSON.parse(text) as Network,
	readRunoff: (text) => JSON.parse(text) as RunoffModule,
	readRainfall: (text) => JSON.parse(text) as RainfallSeries,
	readAnswer(text, fileName) {
		try {
			return JSON.parse(text) as AnswerFile;
		} catch {
			throw new Error(`${fileName}:1:1: not an answer file`);
		}
	},
	writeAnswer: (file) => `${JSON.stringify(file)}\n`,
	answerFromSeries(kind, number, series): AnswerFile {
		const rows: AnswerRow[] = [];
		for (let i = 0; i < series.values.length / 12; i++) {
			const months = series.values.slice(12 * i, 12 * i + 12) as unknown as Monthly12;
			const annualTotal = months.reduce((a, b) => a + b, 0);
			rows.push({ year: series.startYear + i, months, annualTotal, monthlyMean: annualTotal / 12 });
		}
		const mean = (f: (r: AnswerRow) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
		const months = Array.from({ length: 12 }, (_, m) => mean((r) => r.months[m]!)) as unknown as Monthly12;
		return { kind, number, rows, average: { months, annualTotal: mean((r) => r.annualTotal), monthlyMean: mean((r) => r.monthlyMean) } };
	},
	runRunoffModule(module, rainfall, { startYear, endYear }) {
		const values: number[] = [];
		for (let year = startYear; year <= endYear; year++) {
			const row = rainfall.rows.find((r) => r.year === year);
			if (!row) throw new Error(`no rainfall for ${year}`);
			values.push(...row.months.map((pct) => (pct / 100) * module.mapMm * module.areaKm2 * 1e-3 * 0.1));
		}
		const outflow: MonthlySeries = { startYear, values, unit: 'Mm3PerMonth' };
		return { outflow, diagnostics: { netRunoff: outflow }, messages: [] };
	}
};
