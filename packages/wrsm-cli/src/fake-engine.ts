import { readBundle, run, type AnswerFile, type AnswerRow, type Monthly12 } from '@pitman/wrsm';
import type { Engine } from './engine.js';

/**
 * A stand-in `Engine` for CLI tests (not used by the CLI itself): the real
 * bundle reader and network run, but answer "files" are the JSON of their
 * typed object, so tests read and edit answers directly.
 */
export const fakeEngine: Engine = {
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
	readBundle,
	run
};
