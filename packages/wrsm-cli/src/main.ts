import { RUN_MODE_KINDS } from '@pitman/wrsm';

/** Where the CLI writes; injected so tests can capture it. */
export interface Io {
	readonly out: (text: string) => void;
	readonly err: (text: string) => void;
}

/** Exit codes: 0 ok, 1 a failed run or comparison, 2 usage error or not implemented. */
export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

export const USAGE = `Usage: wrsm <command> [options]

Commands:
  run <networkDir> [--mode <${RUN_MODE_KINDS.join('|')}>] [--year <yyyy>] [--out <dir>]
      Run a WRSM2000 network folder and write answer files.
  compare <networkDir> <referenceOutDir>
      Compare a run against WRSM2000's own .ANS outputs.
  help
      Show this message.
`;

/** Run the CLI with `argv` (the arguments after the program name). Returns the exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
	const [command] = argv;
	switch (command) {
		case 'help':
		case '--help':
		case '-h':
			io.out(USAGE);
			return EXIT_OK;
		case 'run':
		case 'compare':
			io.err(`wrsm ${command}: not implemented yet\n`);
			return EXIT_USAGE;
		case undefined:
			io.err(USAGE);
			return EXIT_USAGE;
		default:
			io.err(`wrsm: unknown command '${command}'\n\n${USAGE}`);
			return EXIT_USAGE;
	}
}
