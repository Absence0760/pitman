import { RUN_MODE_KINDS } from '@pitman/wrsm';
// TODO(integration): import from '@pitman/wrsm' once its index.ts exports compare/.
import type { ExpectedRoute } from '../../wrsm/src/compare/index.js';
import { compareCommand } from './compare.js';
import type { Engine } from './engine.js';
import { EXIT_OK, EXIT_USAGE, type Io } from './io.js';
import { DEFAULT_OUT_DIR, runCommand } from './run.js';

export { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type Io } from './io.js';
export type { Engine } from './engine.js';

export const USAGE = `Usage: wrsm <command> [options]

Commands:
  run <networkDir> [--mode <${RUN_MODE_KINDS.join('|')}>] [--year <yyyy>] [--out <dir>]
      Run a WRSM2000 network folder and write answer files (default --out
      <networkDir>/${DEFAULT_OUT_DIR}). Round 2: runoff modules only, each on its own.
  compare <networkDir> <outDir> [--reference <dir>]
      Compare a run against WRSM2000's own .ANS outputs (default reference:
      <networkDir>/Out if present, else <networkDir>).
  help
      Show this message.
`;

/** Options for tests: override the routes expected to match. */
export interface MainOptions {
	readonly expectations?: readonly ExpectedRoute[];
}

/**
 * Run the CLI with `argv` (the arguments after the program name). Returns
 * the exit code. Without an `engine`, `run` and `compare` report "not
 * implemented yet" (until bin.ts wires the real one).
 */
export async function main(argv: readonly string[], io: Io, engine?: Engine, options: MainOptions = {}): Promise<number> {
	const [command, ...rest] = argv;
	switch (command) {
		case 'help':
		case '--help':
		case '-h':
			io.out(USAGE);
			return EXIT_OK;
		case 'run':
		case 'compare':
			if (!engine) {
				io.err(`wrsm ${command}: not implemented yet\n`);
				return EXIT_USAGE;
			}
			return command === 'run' ? runCommand(rest, io, engine) : compareCommand(rest, io, engine, options.expectations);
		case undefined:
			io.err(USAGE);
			return EXIT_USAGE;
		default:
			io.err(`wrsm: unknown command '${command}'\n\n${USAGE}`);
			return EXIT_USAGE;
	}
}
