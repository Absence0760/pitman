import type { AnswerFile, BundleFiles, MonthlySeries, NetworkBundle, ReadBundleOptions, ReadBundleResult, RunMode, RunResult } from '@pitman/wrsm';

/**
 * The engine functions the CLI uses, injected so the commands can be tested
 * with a fake. The real implementation is a plain object of `@pitman/wrsm`
 * exports, wired in `bin.ts`.
 *
 * Readers take the file's text and its name (for `FILE:line:col` errors)
 * and throw on malformed input; writers return the file's text.
 */
export interface Engine {
	/** Read a whole network folder, path → text (`packages/wrsm/src/io/bundle.ts`). */
	readBundle(files: BundleFiles, options?: ReadBundleOptions): ReadBundleResult;
	/** Run a whole network in one mode with the real module simulators. */
	run(bundle: NetworkBundle, mode: RunMode): RunResult;
	/** Parse an `.ANS` answer file (TT 689 §4.5). */
	readAnswer(text: string, fileName: string): AnswerFile;
	/** Write an answer file, byte for byte in WRSM2000's layout. */
	writeAnswer(file: AnswerFile): string;
	/** Build an answer file (annual totals, means, AVERAGE row) from a monthly series. */
	answerFromSeries(kind: 'RQ' | 'RV', number: number, series: MonthlySeries): AnswerFile;
}
