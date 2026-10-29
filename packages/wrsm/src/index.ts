/**
 * @pitman/wrsm: the WRSM/Pitman engine as a pure TypeScript package.
 *
 * No I/O, DOM or Node APIs (issue #3 rule 6): readers and writers take and
 * return strings; the CLI and the app do the file and network work.
 */

export type * from './types.js';

export {
	FieldCursor,
	WrsmParseError,
	splitLines,
	tokenize,
	tokenizeLine,
	type LineEnding,
	type NumberToken,
	type SplitLines,
	type StringToken,
	type Token,
	type TokenLine,
	type TokenizeOptions,
	type WordToken
} from './io/tokens.js';

/** The run modes the engine accepts (decision D1), in the order the UI offers them. */
export const RUN_MODE_KINDS = ['presentDay', 'natural', 'historical'] as const;
