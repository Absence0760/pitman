import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readChannel, writeChannel } from './channel.js';
import { readIrrigation, upgradeIrrigation, writeIrrigation } from './irrigation.js';
import type { IrrigationModule } from '../types.js';
import { readReservoir, writeReservoir } from './reservoir.js';

// The reference comparison (docs/formats.md §3): every reservoir, channel
// and irrigation file under WRSM_REFERENCE_DIR must read and write back byte
// for byte. Skips only when the variable is unset. Prints counts and
// relative paths only, never file contents.

const dir = process.env.WRSM_REFERENCE_DIR;

type Kind = 'RV' | 'CR' | 'RR';

function walk(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		// statSync follows symlinks.
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

/** Module files by type: from each .NET module list, plus the `<net><TT><n>.DAT` name pattern. */
function moduleFiles(root: string): Map<string, Kind> {
	const files = walk(root);
	const byLowerPath = new Map(files.map((f) => [f.toLowerCase(), f]));
	const out = new Map<string, Kind>();
	for (const f of files) {
		const match = /(RV|CR|RR)\d+\.DAT$/i.exec(basename(f));
		if (match) out.set(f, match[1]!.toUpperCase() as Kind);
	}
	for (const net of files.filter((f) => /\.NET$/i.test(f))) {
		const lines = readFileSync(net, 'latin1').split(/\r\n|\r|\n/);
		const code = (lines[0] ?? '').slice(0, 3).trim();
		for (const line of lines) {
			const m = /^(\d{1,4})(RV|CR|RR)[YN]\s*$/.exec(line);
			if (!m) continue;
			const path = byLowerPath.get(join(dirname(net), `${code}${m[2]}${m[1]}.DAT`).toLowerCase());
			if (path) out.set(path, m[2] as Kind);
		}
	}
	return out;
}

interface Codec {
	read(text: string, name: string): unknown;
	write(m: never): string;
	/**
	 * The documented exceptions: a file WRSM2000 didn't write in its own
	 * layout, which the writer normalises without changing a value.
	 */
	exception(source: string, module: never, differingLines: readonly number[]): string | undefined;
	/** Whether the module read back from the written text keeps every value of the original. */
	keepsValues(original: never, reread: never): boolean;
}

const codecs: Record<Kind, Codec> = {
	RV: { read: readReservoir, write: writeReservoir, exception: () => undefined, keepsValues: isDeepStrictEqual },
	CR: {
		read: readChannel,
		write: writeChannel,
		// docs/formats.md §7: hand-made files write L.004 as F0.0 and L.005 in leading-dot style.
		exception: (_source, _m, differing) => (differing.every((n) => n === 4 || n === 5) ? 'hand-made L.004/L.005 layout' : undefined),
		keepsValues: isDeepStrictEqual
	},
	RR: {
		read: readIrrigation,
		write: writeIrrigation,
		// docs/formats.md §8.2: the unversioned WRSM90 layout is upgraded to v32 on write.
		exception: (_source, m: IrrigationModule) => (m.fileVersion === 0 ? 'unversioned layout upgraded to v32' : undefined),
		// The upgrade adds the WQT lines; L.001–L.012 must be unchanged.
		keepsValues: (m: IrrigationModule, reread: IrrigationModule) =>
			m.layout === 'pitman' && isDeepStrictEqual({ ...upgradeIrrigation(m) }, reread)
	}
};

/** 1-based numbers of the lines that differ between two texts. */
function differingLines(a: string, b: string): number[] {
	const x = a.split('\r\n');
	const y = b.split('\r\n');
	const out: number[] = [];
	for (let k = 0; k < Math.max(x.length, y.length); k++) if (x[k] !== y[k]) out.push(k + 1);
	return out;
}

describe.skipIf(!dir)('reference module files round-trip byte for byte', () => {
	const files = dir ? moduleFiles(dir) : new Map<string, Kind>();

	it.each(['RV', 'CR', 'RR'] as const)('%s', (kind) => {
		const codec = codecs[kind];
		const paths = [...files].filter(([, k]) => k === kind).map(([p]) => p);
		const failures: string[] = [];
		const exceptions = new Map<string, number>();
		for (const path of paths) {
			const text = readFileSync(path, 'latin1');
			const rel = relative(dir!, path);
			try {
				const module = codec.read(text, basename(path)) as never;
				const written = codec.write(module);
				if (written === text) continue;
				const differing = differingLines(written, text);
				const why = codec.exception(text, module, differing);
				if (why !== undefined && codec.keepsValues(module, codec.read(written, basename(path)) as never)) {
					exceptions.set(why, (exceptions.get(why) ?? 0) + 1);
					console.log(`  exception (${why}): ${rel}`);
				} else {
					failures.push(`${rel}: differs at line ${differing[0]}`);
				}
			} catch (e) {
				// Quoted text in the message is file content: mask it.
				failures.push(`${rel}: ${(e as Error).message.replace(/'[^']*'/g, "'…'")}`);
			}
		}
		const identical = paths.length - failures.length - [...exceptions.values()].reduce((a, b) => a + b, 0);
		console.log(`${kind}: ${identical}/${paths.length} byte-identical; exceptions ${JSON.stringify(Object.fromEntries(exceptions))}; failures ${failures.length}`);
		for (const f of failures) console.log(`  ${f}`);
		expect(paths.length).toBeGreaterThan(0);
		expect(failures).toEqual([]);
	});
});
