import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readChannel } from '../io/channel.js';
import { readDemand } from '../io/demand.js';
import { readIrrigation } from '../io/irrigation.js';
import { readNetwork } from '../io/network.js';
import { readObserved } from '../io/observed.js';
import { readRainfall } from '../io/rainfall.js';
import { readReservoir } from '../io/reservoir.js';
import { readRunoff } from '../io/runoff.js';
import type { DemandSeries, Module, NetworkBundle, ObservedFlow, RainfallSeries } from '../types.js';
import { validateNetwork } from './validate.js';

// Local-only check (issue #3 rule 2): every .NET under WRSM_REFERENCE_DIR,
// with the module, rainfall, defined-flow and observed files it names, goes
// through validateNetwork. Skips only when the variable is unset. Builds
// each bundle with the Round 2 readers (agent 3.4's readBundle isn't
// available to this branch) and prints counts only, never names or values.

const dir = process.env.WRSM_REFERENCE_DIR;

function walk(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

const read = (path: string) => readFileSync(path, 'latin1');
const base = (name: string) => name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1).trim().toUpperCase();

/** What kind of problem a message is, for the counts. */
function category(text: string): string {
	if (text.startsWith('sequence error')) return 'sequence';
	if (text.startsWith('circular')) return 'cycle';
	if (/has no file/.test(text)) return 'module file missing';
	if (/defined-flow file .* not in the network/.test(text)) return 'defined-flow file missing';
	if (/rainfall file .* not in the network/.test(text)) return 'rainfall file missing';
	if (/observed-flow file/.test(text)) return 'observed file missing';
	if (/percentages/.test(text)) return 'RU percentages';
	if (/zero module/.test(text)) return 'zero-module route';
	if (/routes it|doesn't name it|not a route in/.test(text)) return 'module file vs .NET';
	if (/SFR child/.test(text)) return 'SFR child';
	if (/Table 2\.1/.test(text)) return 'route limit';
	return 'other';
}

describe.skipIf(!dir)('network connectivity against WRSM_REFERENCE_DIR', () => {
	it('validates every reference .NET', () => {
		const files = walk(dir as string);
		const byFolder = new Map<string, Map<string, string>>();
		for (const path of files) {
			const folder = dirname(path);
			if (!byFolder.has(folder)) byFolder.set(folder, new Map());
			byFolder.get(folder)!.set(basename(path).toUpperCase(), path);
		}
		const tally = { networks: 0, valid: 0, withErrors: 0, withWarnings: 0, unreadableModules: 0, errors: {} as Record<string, number>, warnings: {} as Record<string, number> };
		const failures: string[] = [];

		for (const netPath of files.filter((p) => /\.net$/i.test(p))) {
			tally.networks++;
			const folder = byFolder.get(dirname(netPath))!;
			const network = readNetwork(read(netPath), basename(netPath));
			const modules: Module[] = [];
			const rainfall: Record<string, RainfallSeries> = {};
			const flowFiles: Record<string, DemandSeries> = {};
			const observed: Record<string, ObservedFlow> = {};
			const load = <T>(record: Record<string, T>, name: string | null, reader: (text: string, name: string) => T) => {
				if (!name || name === '*') return;
				const key = base(name);
				const path = folder.get(key);
				if (path && !(key in record)) record[key] = reader(read(path), basename(path));
			};
			for (const entry of network.modules) {
				const path = folder.get(`${network.code}${entry.type}${entry.number}.DAT`.toUpperCase());
				if (!path) continue;
				const text = read(path);
				const name = basename(path);
				try {
					const m: Module =
						entry.type === 'RU' ? readRunoff(text, name) : entry.type === 'RV' ? readReservoir(text, name) : entry.type === 'CR' ? readChannel(text, name) : readIrrigation(text, name);
					modules.push(m);
					if (m.kind === 'RU' || m.kind === 'RV') load(rainfall, m.rainfallFile, readRainfall);
					if (m.kind === 'CR') load(rainfall, m.wetlandRainfallFile, readRainfall);
					if (m.kind === 'RV' || m.kind === 'CR') for (const c of [...m.inflows, ...m.outflows]) load(flowFiles, c.definedFlowFile, readDemand);
				} catch (error) {
					tally.unreadableModules++;
					modules.push({ kind: 'unparsed', moduleType: entry.type, number: entry.number, name: '', reason: (error as Error).message, lines: [] });
				}
			}
			for (const gauge of network.gauges) load(observed, gauge.observedFile, readObserved);

			const bundle: NetworkBundle = { network, modules, rainfall, flowFiles, observed };
			const messages = validateNetwork(bundle);
			const errors = messages.filter((m) => m.level === 'error');
			if (errors.length === 0) tally.valid++;
			else tally.withErrors++;
			if (messages.some((m) => m.level === 'warning')) tally.withWarnings++;
			for (const m of messages) {
				const bucket = m.level === 'error' ? tally.errors : m.level === 'warning' ? tally.warnings : undefined;
				if (bucket) bucket[category(m.text)] = (bucket[category(m.text)] ?? 0) + 1;
			}
			// Anything but the known findings (below) fails the suite: counts only, never the network's name.
			for (const m of errors) if (!KNOWN.includes(category(m.text))) failures.push(`network #${tally.networks}: ${category(m.text)}`);
		}
		console.log(JSON.stringify(tally, null, 1));
		expect(tally.networks).toBeGreaterThan(0);
		expect(tally.unreadableModules).toBe(0);
		expect(failures).toEqual([]);
	});
});

/**
 * Errors the reference set is known to contain, reported but not failed
 * (docs/theory/network.md §8): one public network solves a runoff module
 * after the channel it drains into, a sequence error by the manual's rule
 * (R3-N3). Everything else in the set validates.
 */
const KNOWN = ['sequence'];
