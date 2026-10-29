import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readChannel } from '../io/channel.js';
import type { ModuleRunContext, RouteFlows } from '../network/contract.js';
import { seededRandom } from '../synthetic/synthetic.js';
import type { ChannelModule, Monthly12 } from '../types.js';
import { runChannel } from './channel.js';

// Local only (WRSM_REFERENCE_DIR): every reference channel reach runs under
// the simulator with synthetic inflows, demands, defined flows and rainfall,
// in every mode, and keeps its water balance. This checks that real module
// data passes validation and exercises the code paths real files use; it
// compares nothing against WRSM2000's outputs (that is the network
// comparison's job). Prints counts and relative paths only.

const dir = process.env.WRSM_REFERENCE_DIR;

function walk(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

/** CR files a `.NET` lists (code + `CR` + number), so orphan modules no network solves are left out. */
function networkChannelFiles(root: string): string[] {
	const files = walk(root);
	const byLowerPath = new Map(files.map((f) => [f.toLowerCase(), f]));
	const out = new Set<string>();
	for (const net of files.filter((f) => /\.NET$/i.test(f))) {
		const lines = readFileSync(net, 'latin1').split(/\r\n|\r|\n/);
		const code = (lines[0] ?? '').slice(0, 3).trim();
		for (const line of lines) {
			const m = /^(\d{1,4})CR[YN]\s*$/.exec(line);
			const path = m && byLowerPath.get(join(dirname(net), `${code}CR${m[1]}.DAT`).toLowerCase());
			if (path) out.add(path);
		}
	}
	return [...out].sort();
}

describe.skipIf(!dir)('reference channel reaches run and balance', () => {
	it('every CR file', () => {
		const paths = networkChannelFiles(dir!);
		const rnd = seededRandom(42);
		const start = 1990;
		const end = 1994;
		const n = 60;
		const twelve = () => Array.from({ length: 12 }, () => rnd() * 300) as unknown as Monthly12;
		const failures: string[] = [];
		const types = new Map<number, number>();
		let unreadable = 0;
		for (const path of paths) {
			const rel = relative(dir!, path);
			let module: ChannelModule;
			try {
				module = readChannel(readFileSync(path, 'latin1'), basename(path));
			} catch {
				unreadable++; // reading is the reader suite's job; counted, not hidden
				continue;
			}
			types.set(module.wetlandType, (types.get(module.wetlandType) ?? 0) + 1);
			const inflows: Record<number, { startYear: number; values: number[]; unit: 'Mm3' }> = {};
			for (const c of module.inflows) inflows[c.route] = { startYear: start, values: Array.from({ length: n }, () => rnd() * 5), unit: 'Mm3' };
			const demands: RouteFlows = Object.fromEntries(
				module.outflows.filter((c) => c.route !== module.principalOutflowRoute && c.definedFlowFile === null).map((c) => [c.route, { startYear: start, values: Array.from({ length: n }, () => rnd()), unit: 'Mm3' as const }])
			);
			for (const mode of [{ kind: 'historical' }, { kind: 'natural' }, { kind: 'presentDay', year: 2025 }] as const) {
				const ctx: ModuleRunContext = {
					mode,
					startYear: start,
					endYear: end,
					rainfall: () => ({ code: 'S', rows: Array.from({ length: 5 }, (_, k) => ({ year: start + k, months: twelve() })) }),
					flowFile: (name) => ({ fileName: name, rows: Array.from({ length: 5 }, (_, k) => ({ year: start + k, months: twelve().map((v) => v / 300) as unknown as Monthly12 })), hasTotals: false, hasAverage: false })
				};
				try {
					const r = runChannel(module, inflows, ctx, demands);
					const b = r.breakdown;
					let previous = b.initialStorage;
					for (let t = 0; t < n; t++) {
						const out = Object.values(r.outflows).reduce((s, v) => s + v.values[t]!, 0);
						const balance = b.inflow.values[t]! + b.created.values[t]! - out - b.bedLoss.values[t]! - b.lost.values[t]! - b.wetlandNetEvaporation.values[t]! - (b.storage.values[t]! - previous);
						if (Math.abs(balance) > 1e-9) throw new Error(`balance off by ${balance} in month ${t + 1}`);
						previous = b.storage.values[t]!;
					}
				} catch (e) {
					failures.push(`${rel} (${mode.kind}): ${(e as Error).message.replace(/'[^']*'/g, "'…'")}`);
				}
			}
		}
		console.log(`CR: ${paths.length} files listed by a .NET run in 3 modes (${unreadable} unreadable); wetland types ${JSON.stringify(Object.fromEntries(types))}; failures ${failures.length}`);
		for (const f of failures) console.log(`  ${f}`);
		expect(failures).toEqual([]);
	});
});
