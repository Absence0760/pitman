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

// File readers and writers (docs/formats.md). Readers take `(text, fileName)`; writers return the text.
export * from './io/network.js';
export * from './io/rainfall.js';
export * from './io/observed.js';
export * from './io/answer.js';
export * from './io/demand.js';
export * from './io/runoff.js';
export * from './io/reservoir.js';
export * from './io/channel.js';
export * from './io/irrigation.js';
// A whole network folder: path → text in, NetworkBundle out, and back (Round 3).
export * from './io/bundle.js';

// The classic Pitman runoff module (docs/theory/pitman.md).
export * from './runoff/rain.js';
export * from './runoff/lag.js';
export * from './runoff/pitman.js';

// Round 3: the contract between the network runner and the module simulators,
// the runner (docs/theory/network.md), reservoirs (reservoir.md), channel
// reaches (channel.md), flow statistics (statistics.md), and the whole-network run.
export * from './network/contract.js';
export * from './network/index.js';
export * from './reservoir/index.js';
export * from './channel/index.js';
export * from './stats/index.js';
export * from './run.js';

// Round 4 contract for method A, the CHIRPS extension (docs/theory/extend.md).
export * from './extend/contract.js';
export * from './extend/index.js';

// Comparison against WRSM2000 outputs, and a synthetic network for tests.
export * from './compare/index.js';
export * from './synthetic/index.js';

/** The run modes the engine accepts (decision D1), in the order the UI offers them. */
export const RUN_MODE_KINDS = ['presentDay', 'natural', 'historical'] as const;
