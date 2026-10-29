/**
 * Validate loaded files as a network (`readBundle`) and describe the
 * outcome for the page: loaded, a choice of `.NET` to make, or the errors.
 */

import type { NetworkBundle } from '@pitman/wrsm';
import { readBundle, type BundleFiles, type BundleIssue, type LoadedBundle } from './engine.js';

export type OpenOutcome =
	| { readonly kind: 'loaded'; readonly bundle: LoadedBundle; readonly warnings: readonly BundleIssue[] }
	/** Several `.NET` files and none chosen yet. */
	| { readonly kind: 'choose'; readonly networks: readonly string[] }
	| { readonly kind: 'invalid'; readonly errors: readonly BundleIssue[]; readonly warnings: readonly BundleIssue[] };

/** Read `files` as a network, `network` naming the `.NET` when there are several. */
export function openNetwork(files: BundleFiles, network?: string): OpenOutcome {
	const result = readBundle(files, network === undefined ? {} : { network });
	if (result.ok) return { kind: 'loaded', bundle: result.bundle, warnings: result.warnings };
	if (network === undefined && result.networks.length > 1) return { kind: 'choose', networks: result.networks };
	return { kind: 'invalid', errors: result.errors, warnings: result.warnings };
}

/** A one-glance description of a loaded network. */
export interface NetworkSummary {
	readonly code: string;
	readonly startYear: number;
	readonly endYear: number;
	/** Module count by type code, in RU, RV, RR, CR, MM order, types present only. */
	readonly modules: readonly { readonly type: string; readonly label: string; readonly count: number }[];
	readonly routes: number;
	readonly gauges: number;
	readonly rainfallFiles: number;
	readonly flowFiles: number;
	/** Modules the engine keeps but doesn't model (e.g. mine modules). */
	readonly notModelled: readonly string[];
	readonly hasSidecar: boolean;
}

const MODULE_LABELS: Readonly<Record<string, string>> = {
	RU: 'runoff',
	RV: 'reservoir',
	RR: 'irrigation',
	CR: 'channel reach',
	MM: 'mine'
};

export function summarise(bundle: NetworkBundle): NetworkSummary {
	const counts = new Map<string, number>();
	for (const entry of bundle.network.modules) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
	return {
		code: bundle.network.code,
		startYear: bundle.network.startYear,
		endYear: bundle.network.endYear,
		modules: Object.keys(MODULE_LABELS)
			.filter((t) => counts.has(t))
			.map((type) => ({ type, label: MODULE_LABELS[type] as string, count: counts.get(type) as number })),
		routes: bundle.network.routes.length,
		gauges: bundle.network.gauges.length,
		rainfallFiles: Object.keys(bundle.rainfall).length,
		flowFiles: Object.keys(bundle.flowFiles).length,
		notModelled: bundle.modules.filter((m) => m.kind === 'unparsed').map((m) => (m.kind === 'unparsed' ? `${m.number}${m.moduleType}: ${m.reason}` : '')),
		hasSidecar: bundle.sidecar !== undefined
	};
}

/** The plain `NetworkBundle`, without the file index (what a run needs, lighter to post to the worker). */
export function engineBundle(bundle: NetworkBundle): NetworkBundle {
	const { network, modules, rainfall, observed, flowFiles, sidecar } = bundle;
	return { network, modules, rainfall, observed, flowFiles, ...(sidecar !== undefined && { sidecar }) };
}
