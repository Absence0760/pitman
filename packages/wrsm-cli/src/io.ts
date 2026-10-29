/** Where the CLI writes; injected so tests can capture it. */
export interface Io {
	readonly out: (text: string) => void;
	readonly err: (text: string) => void;
}

/** Exit codes: 0 ok, 1 a failed run or comparison, 2 usage error or not implemented. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
