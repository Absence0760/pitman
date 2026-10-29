import type {
	AnswerFile,
	MonthlySeries,
	Network,
	RainfallSeries,
	RunMessage,
	RunoffDiagnostics,
	RunoffModule
} from '@pitman/wrsm';

/**
 * The engine functions the CLI uses, injected so the commands can be tested
 * with a fake and so the CLI does not depend on readers other Round 2 agents
 * are still writing. The real implementation is a plain object of
 * `@pitman/wrsm` exports, wired in `bin.ts`.
 *
 * Readers take the file's text and its name (for `FILE:line:col` errors)
 * and throw on malformed input; writers return the file's text.
 */
export interface Engine {
	/** Parse a `.NET` file (TT 691 §12.6). */
	readNetwork(text: string, fileName: string): Network;
	/** Parse a runoff module file, `<net>RU<n>.DAT` (TT 691 §12.1). */
	readRunoff(text: string, fileName: string): RunoffModule;
	/** Parse a `.RAN` rainfall file (TT 691 §12.7.2). */
	readRainfall(text: string, fileName: string): RainfallSeries;
	/** Parse an `.ANS` answer file (TT 689 §4.5). */
	readAnswer(text: string, fileName: string): AnswerFile;
	/** Write an answer file, byte for byte in WRSM2000's layout. */
	writeAnswer(file: AnswerFile): string;
	/** Build an answer file (annual totals, means, AVERAGE row) from a monthly series. */
	answerFromSeries(kind: 'RQ' | 'RV', number: number, series: MonthlySeries): AnswerFile;
	/** Run one runoff module on its own over `startYear`–`endYear` (no upstream inflows). */
	runRunoffModule(
		module: RunoffModule,
		rainfall: RainfallSeries,
		options: { startYear: number; endYear: number }
	): { outflow: MonthlySeries; diagnostics: RunoffDiagnostics; messages: RunMessage[] };
}
