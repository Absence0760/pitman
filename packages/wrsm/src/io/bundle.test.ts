import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { syntheticNetwork } from '../synthetic/index.js';
import type { NetworkBundle, RunoffModule, Sidecar } from '../types.js';
import { bundleKey, moduleKey, readBundle, sameData, writeBundle, type BundleFiles, type LoadedBundle } from './bundle.js';

// Synthetic fixtures only: the byte-exact examples in docs/formats/examples/
// and made-up text below.

const exampleDir = fileURLToPath(new URL('../../../../docs/formats/examples/network/', import.meta.url));

function walk(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

/** The example network folder, Latin-1 decoded, under `prefix`. */
function example(prefix = ''): Record<string, string> {
	return Object.fromEntries(walk(exampleDir).map((p) => [prefix + relative(exampleDir, p).split('\\').join('/'), readFileSync(p, 'latin1')]));
}

function loaded(files: BundleFiles, network?: string): LoadedBundle {
	const result = readBundle(files, network === undefined ? {} : { network });
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.bundle;
}

const SIDECAR: Sidecar = { schema: 'pitman-sidecar', schemaVersion: 1, writtenBy: 'pitman test', values: [] };

describe('readBundle: the synthetic example network', () => {
	it('reads the .NET, every module, rainfall, gauge and defined-flow file', () => {
		const bundle = loaded(example());
		expect(bundle.network.code).toBe('SY');
		expect(bundle.modules.map(moduleKey)).toEqual(['RU1', 'RU11', 'RU12', 'RU2', 'RR6', 'RV3', 'CR5', 'RV4']);
		expect(Object.keys(bundle.rainfall)).toEqual(['SYA.RAN']);
		expect(Object.keys(bundle.observed)).toEqual(['SYH001.OBS']);
		expect(Object.keys(bundle.flowFiles).sort()).toEqual(['SYDOM.ABS', 'SYINF.ABS']);
		expect(bundle.flowFiles['SYINF.ABS']?.fileName).toBe('SYINF.abs');
		expect(bundle.sidecar).toBeUndefined();
		expect(bundle.files.root).toBe('');
		expect(bundle.files.modules.RU11).toBe('SYRU11.DAT');
	});

	it('keeps the files no reader uses (Out/, .lst, .nat) as they are', () => {
		const files = example();
		const bundle = loaded(files);
		expect(Object.keys(bundle.files.other).sort()).toEqual(
			['Out/SYRQ7.DEM', 'Out/SYRQ9.ANS', 'Out/SYRU1ncr.MTS', 'Out/SYRU2ncr.MTS', 'Out/WRSM2000.ERR', 'SY.lst', 'SY.nat'].sort()
		);
		expect(bundle.files.other['SY.lst']).toBe(files['SY.lst']);
	});

	it('writes every file back byte for byte', () => {
		const files = example();
		expect(writeBundle(loaded(files))).toEqual(files);
	});

	it('finds the network inside a wrapping folder and writes it back there', () => {
		const files = example('Net/');
		const bundle = loaded(files);
		expect(bundle.files.root).toBe('Net/');
		expect(bundle.files.network).toBe('Net/SY.NET');
		expect(writeBundle(bundle)).toEqual(files);
	});

	it('normalises backslashes and leading ./ in paths', () => {
		const files = Object.fromEntries(Object.entries(example()).map(([p, t]) => [`.\\${p.replace(/\//g, '\\')}`, t]));
		expect(loaded(files).files.other['Out/WRSM2000.ERR']).toBeDefined();
	});
});

describe('readBundle: names are case-insensitive (docs/formats.md §1.3)', () => {
	it('resolves module and referenced files whatever their case on disk', () => {
		const files = Object.fromEntries(Object.entries(example()).map(([p, t]) => [p === 'SY.NET' ? p : p.toLowerCase(), t]));
		const bundle = loaded(files);
		expect(bundle.files.modules.RU1).toBe('syru1.dat');
		expect(bundle.files.rainfall['SYA.RAN']).toBe('sya.ran');
		// …and writes each file back under its own spelling.
		expect(writeBundle(bundle)).toEqual(files);
	});

	it('resolves a relative path and an absolute Windows path by base name', () => {
		const files = example();
		const ru1 = files['SYRU1.DAT']!;
		const withPaths = {
			...files,
			'SYRU1.DAT': ru1.replace("'SYA.RAN'", "'C:\\WRSM\\SY\\SYA.RAN'"),
			'SYRU2.DAT': files['SYRU2.DAT']!.replace("'SYA.RAN'", "'RAIN\\SYB.RAN'"),
			'RAIN/SYB.RAN': files['SYA.RAN']!
		};
		const bundle = loaded(withPaths);
		expect(bundle.files.rainfall['C:\\WRSM\\SY\\SYA.RAN']).toBe('SYA.RAN');
		expect(bundle.files.rainfall['RAIN\\SYB.RAN']).toBe('RAIN/SYB.RAN');
		expect(writeBundle(bundle)).toEqual(withPaths);
	});

	it('bundleKey trims and upper-cases', () => {
		expect(bundleKey('  zero.Ran ')).toBe('ZERO.RAN');
	});
});

describe('readBundle: errors name the file, line and field, and are all collected', () => {
	it('reports a parse error with its location', () => {
		const files = example();
		const bad = { ...files, 'SYRU1.DAT': files['SYRU1.DAT']!.replace('  120.0  650', '  12x.0  650') };
		const result = readBundle(bad);
		expect(result.ok).toBe(false);
		expect(result.errors).toEqual([expect.objectContaining({ level: 'error', file: 'SYRU1.DAT', line: 2, field: expect.stringContaining('L.002') })]);
	});

	it('collects errors from several files at once', () => {
		const files: Record<string, string> = example();
		delete files['SYRV4.DAT'];
		delete files['SYINF.abs'];
		const bad = { ...files, 'SYA.RAN': files['SYA.RAN']!.replace(/^(.{11}).{7}/m, '$1  abc  ') };
		const result = readBundle(bad);
		expect(result.ok).toBe(false);
		const byFile = result.errors.map((e) => [e.file, e.field ?? '']);
		expect(byFile).toEqual(
			expect.arrayContaining([
				['SYRV4.DAT', ''],
				['SYCR5.DAT', expect.stringContaining('defined-flow file')],
				['SYA.RAN', 'month 1']
			])
		);
		expect(result.errors.find((e) => e.file === 'SYRV4.DAT')?.message).toMatch(/module file not found/);
	});

	it('reports a missing rainfall file against the module that names it', () => {
		const files: Record<string, string> = example();
		delete files['SYA.RAN'];
		const result = readBundle(files);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatchObject({ file: 'SYRU1.DAT', field: 'L.002 rainfall file', message: "names 'SYA.RAN', which is not in the folder" });
		// One error per missing file, not one per module naming it.
		expect(result.errors.filter((e) => e.message.includes('SYA.RAN'))).toHaveLength(1);
	});

	it('reports a missing gauge file', () => {
		const files: Record<string, string> = example();
		delete files['SYH001.obs'];
		const result = readBundle(files);
		expect(result.errors).toEqual([expect.objectContaining({ file: 'SY.NET', field: 'NET.11 gauge 1 observed file' })]);
	});

	it('reports a module whose number differs from its file name', () => {
		const files = example();
		const result = readBundle({ ...files, 'SYRU2.DAT': files['SYRU1.DAT']! });
		expect(result.errors).toEqual([expect.objectContaining({ file: 'SYRU2.DAT', field: 'L.001 module number' })]);
	});

	it('reports a bad .NET and stops there', () => {
		const result = readBundle({ 'X.NET': 'nonsense\r\n' });
		expect(result.ok).toBe(false);
		expect(result.errors[0]?.file).toBe('X.NET');
		expect(result.errors[0]?.line).toBeGreaterThan(0);
	});

	it('warns on non-ASCII bytes and still loads (R2-3, docs/formats.md §1.1)', () => {
		const files = example();
		const named = { ...files, 'SYRU1.DAT': files['SYRU1.DAT']!.replace('SY Parent', 'SY Par\xe9nt') };
		const result = readBundle(named);
		expect(result.ok).toBe(true);
		expect(result.warnings).toEqual([expect.objectContaining({ level: 'warning', file: 'SYRU1.DAT', line: 1 })]);
		// Unchanged, it saves byte for byte, though the writer would refuse the name.
		if (result.ok) expect(writeBundle(result.bundle)).toEqual(named);
	});
});

describe('readBundle: which network', () => {
	it('says so when there is no .NET', () => {
		const result = readBundle({ 'a.txt': 'x' });
		expect(result).toMatchObject({ ok: false, networks: [] });
		expect(result.errors[0]?.message).toMatch(/no network file/);
	});

	it('lists every .NET when there are several and none is chosen', () => {
		const files = { ...example(), 'SY2.NET': example()['SY.NET']! };
		const result = readBundle(files);
		expect(result).toMatchObject({ ok: false, networks: ['SY.NET', 'SY2.NET'] });
		expect(result.errors[0]?.message).toMatch(/2 network files/);
	});

	it('reads the chosen one, case-insensitively, and keeps the other', () => {
		const files = { ...example(), 'SY2.NET': example()['SY.NET']! };
		const bundle = loaded(files, 'sy.net');
		expect(bundle.files.network).toBe('SY.NET');
		expect(bundle.files.other['SY2.NET']).toBeDefined();
		expect(writeBundle(bundle)).toEqual(files);
	});

	it('rejects a chosen network that is not there', () => {
		expect(readBundle(example(), { network: 'NOPE.NET' }).ok).toBe(false);
	});

	it('ignores macOS clutter when looking for the network', () => {
		const files = { ...example(), '__MACOSX/._SY.NET': '\x00\x05', '._SY.NET': '\x00' };
		const bundle = loaded(files);
		expect(bundle.files.other['__MACOSX/._SY.NET']).toBe('\x00\x05');
	});
});

describe('readBundle / writeBundle: the sidecar', () => {
	it('reads pitman.json and writes it back verbatim when unchanged', () => {
		const text = '{"schema":"pitman-sidecar","schemaVersion":1}';
		const files = { ...example(), 'pitman.json': text };
		const bundle = loaded(files);
		expect(bundle.sidecar).toEqual({ schema: 'pitman-sidecar', schemaVersion: 1 });
		expect(writeBundle(bundle)['pitman.json']).toBe(text);
	});

	it('writes a changed sidecar as two-space JSON', () => {
		const bundle = loaded({ ...example(), 'pitman.json': '{"schema":"pitman-sidecar","schemaVersion":1}' });
		const out = writeBundle({ ...bundle, sidecar: SIDECAR });
		expect(JSON.parse(out['pitman.json']!)).toEqual(SIDECAR);
		expect(out['pitman.json']).toBe(`${JSON.stringify(SIDECAR, null, 2)}\n`);
	});

	it('adds pitman.json at the root when a bundle gains a sidecar', () => {
		const bundle = loaded(example('Net/'));
		expect(Object.keys(writeBundle({ ...bundle, sidecar: SIDECAR }))).toContain('Net/pitman.json');
	});

	it.each([
		['not JSON', '{', /not valid JSON/],
		['another schema', '{"schema":"x"}', /not a Pitman sidecar/],
		['a newer version', '{"schema":"pitman-sidecar","schemaVersion":2}', /schemaVersion 2/]
	])('rejects %s', (_what, text, message) => {
		const result = readBundle({ ...example(), 'pitman.json': text });
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatchObject({ file: 'pitman.json', message: expect.stringMatching(message) });
	});
});

describe('writeBundle: changed content', () => {
	it('rewrites only the module that changed, in the standard layout', () => {
		const files = example();
		const bundle = loaded(files);
		const ru1 = bundle.modules[0] as RunoffModule;
		const edited = { ...bundle, modules: [{ ...ru1, areaKm2: 99.5 }, ...bundle.modules.slice(1)] };
		const out = writeBundle(edited);
		expect(out['SYRU1.DAT']).not.toBe(files['SYRU1.DAT']);
		expect(out['SYRU1.DAT']).toContain('   99.5');
		for (const path of Object.keys(files).filter((p) => p !== 'SYRU1.DAT')) expect(out[path], path).toBe(files[path]);
	});

	it('survives a structured clone (the IndexedDB copy and the worker message)', () => {
		const files = example();
		expect(writeBundle(structuredClone(loaded(files)))).toEqual(files);
	});

	it('names the file when a writer cannot write a value', () => {
		const bundle = loaded(example());
		const ru1 = bundle.modules[0] as RunoffModule;
		const bad = { ...bundle, modules: [{ ...ru1, areaKm2: Number.POSITIVE_INFINITY }, ...bundle.modules.slice(1)] };
		expect(() => writeBundle(bad)).toThrow(/^SYRU1\.DAT: /);
	});

	it('refuses two records that would write different text to one file', () => {
		const bundle = loaded(example());
		const series = bundle.rainfall['SYA.RAN']!;
		const clash: LoadedBundle = {
			...bundle,
			rainfall: { ...bundle.rainfall, 'C:\\SYA.RAN': { ...series, rows: series.rows.slice(1) } },
			files: { ...bundle.files, rainfall: { ...bundle.files.rainfall, 'C:\\SYA.RAN': 'SYA.RAN' } }
		};
		expect(() => writeBundle(clash)).toThrow(/two records/);
	});
});

describe('writeBundle: a bundle built in code', () => {
	const synthetic = syntheticNetwork();
	const bundle: NetworkBundle = {
		network: synthetic.network,
		modules: synthetic.runoff,
		rainfall: Object.fromEntries(synthetic.rainfall.map((r) => [bundleKey(r.fileName), r.series])),
		observed: {},
		flowFiles: {},
		sidecar: SIDECAR
	};

	it('names files <code>.NET, <code><TT><n>.DAT, each record by its key, and pitman.json', () => {
		expect(Object.keys(writeBundle(bundle)).sort()).toEqual(['SY.NET', 'SYA.RAN', 'SYB.RAN', 'SYRU1.DAT', 'SYRU2.DAT', 'SYRU3.DAT', 'pitman.json']);
	});

	it('reads back to the same network (apart from the .NET entry with no file)', () => {
		const result = readBundle(writeBundle(bundle));
		// CR4 is a .NET entry only in the synthetic network.
		expect(result.ok).toBe(false);
		expect(result.errors).toEqual([expect.objectContaining({ file: 'SYCR4.DAT', message: expect.stringMatching(/module file not found/) })]);
	});
});

describe('sameData', () => {
	it('treats an absent key and an undefined one alike, and compares deeply', () => {
		expect(sameData({ a: 1, b: undefined }, { a: 1 })).toBe(true);
		expect(sameData({ a: [1, { c: 2 }] }, { a: [1, { c: 2 }] })).toBe(true);
		expect(sameData({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
		expect(sameData([1], { 0: 1 })).toBe(false);
		expect(sameData(null, {})).toBe(false);
		expect(sameData(Number.NaN, Number.NaN)).toBe(true);
	});
});
