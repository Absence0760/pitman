/**
 * `run()`: a whole network in one mode, with the real module simulators.
 *
 * Owned by the orchestrator. Round 3 wires it at integration (the network
 * runner from `src/network/`, reservoirs from `src/reservoir/`, channels
 * from `src/channel/`); until then it throws, and callers (the app's Web
 * Worker, the CLI) inject a fake in their tests.
 */

import type { NetworkBundle, RunMode, RunResult } from './types.js';

export function run(_bundle: NetworkBundle, _mode: RunMode): RunResult {
	throw new Error('run(): network routing is wired at Round 3 integration');
}
