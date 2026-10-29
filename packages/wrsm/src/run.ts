/**
 * `run()`: a whole network in one mode, with the real module simulators —
 * the network runner (`src/network/`, docs/theory/network.md) calling the
 * reservoir (`src/reservoir/`) and channel reach (`src/channel/`)
 * simulators. Callers that want fakes or non-default options use
 * `runNetwork` directly.
 */

import { simulateChannel } from './channel/index.js';
import type { ModuleSimulators } from './network/contract.js';
import { runNetwork } from './network/index.js';
import { simulateReservoir } from './reservoir/index.js';
import type { PitmanOptions } from './runoff/pitman.js';
import type { NetworkBundle, RunMode, RunResult } from './types.js';

/** The real module simulators with their default options. */
export const DEFAULT_SIMULATORS: ModuleSimulators = { reservoir: simulateReservoir, channel: simulateChannel };

export function run(bundle: NetworkBundle, mode: RunMode, options: { readonly pitman?: Partial<PitmanOptions> } = {}): RunResult {
	return runNetwork(bundle, mode, { simulators: DEFAULT_SIMULATORS, ...options });
}
