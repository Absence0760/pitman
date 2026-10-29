/**
 * A whole network folder: `readBundle` turns a map of files into a
 * `NetworkBundle`, `writeBundle` turns a bundle back into the map
 * (docs/formats.md §1, §3, §11.9; decision R2-4).
 *
 * **Files are text, one character per byte.** The caller decodes every
 * WRSM2000 file (and every file Pitman doesn't read) as **Latin-1**, so each
 * byte 0–255 becomes the character with that code and nothing is lost, even
 * in a binary `.pdf` or `.dwg` kept beside the network (§1.1, §11.9). It
 * encodes them back the same way. The one exception is the sidecar,
 * `pitman.json`, which is UTF-8 JSON: the caller decodes it as UTF-8. The
 * engine is pure (issue #3 rule 6), so the byte work is the caller's; the
 * app's `frontend/src/lib/network/zip.ts` does it.
 *
 * **Paths** are relative, `/`-separated, as in a zip or a folder upload. A
 * zip may wrap the network in a folder (`H00/H00.NET`); the folder holding
 * the `.NET` is the network's root, and every name a file gives is resolved
 * inside it, case-insensitively (§1.3): as a relative path (`RAIN\X.RAN`;
 * an absolute path inside the `.NET`'s input directory, NET.2, counts as
 * relative to it). Failing that (an absolute path elsewhere, a relative
 * one that isn't there) it is matched by base name, in the root or in the
 * one file below it with that name, **with a warning**, since WRSM2000
 * would read a file on its own machine that may differ.
 *
 * **Keys.** `NetworkBundle` records are keyed by the name **as a module or
 * the `.NET` gives it, trimmed and upper-cased** (`bundleKey`), so
 * `ctx.rainfall(name)` is `bundle.rainfall[bundleKey(name)]`. Names that
 * resolve to one file (`SYA.RAN`, `.\SYA.RAN`) are keys to **one shared
 * record**; an editor must replace it under every key (`files.<record>`
 * maps each key to its path), or `writeBundle` refuses the clash.
 *
 * **Optional references.** A type-0 (no wetland) channel's wetland rainfall
 * file is a dummy (TT 691 §12.2): missing or unreadable, it is a warning.
 * It never hides a required reference to the same name.
 *
 * **Lossless.** `readBundle` keeps every file it read verbatim
 * (`files.sources`) and every file it didn't (`files.other`, e.g. `Out/`,
 * diagrams, a second `.NET`). `writeBundle` writes a file back verbatim when
 * its object is unchanged (equal to what reading its source gives), and
 * through its writer otherwise, so an unchanged network saves byte for byte
 * and an edited one gets WRSM2000's standard layout for what changed.
 *
 * **Errors** name the file, line and field. `readBundle` collects every
 * file's error instead of stopping at the first (each reader still stops at
 * its file's first error). Missing files are errors; non-ASCII bytes in a
 * WRSM2000 file are warnings (§1.1).
 */

import type {
	DemandSeries,
	Module,
	ModuleTypeCode,
	Network,
	NetworkBundle,
	ObservedFlow,
	RainfallSeries,
	Sidecar,
	UnparsedModule
} from '../types.js';
import { readChannel, writeChannel } from './channel.js';
import { readDemand, writeDemand } from './demand.js';
import { readIrrigation, writeIrrigation } from './irrigation.js';
import { joinLines } from './module-file.js';
import { readNetwork, writeNetwork } from './network.js';
import { readObserved, writeObserved } from './observed.js';
import { readRainfall, writeRainfall } from './rainfall.js';
import { readReservoir, writeReservoir } from './reservoir.js';
import { readRunoff, writeRunoff } from './runoff.js';
import { WrsmParseError, splitLines } from './tokens.js';

/** A network folder: relative `/`-separated path → file text (Latin-1 decoded; `pitman.json` UTF-8). */
export type BundleFiles = Readonly<Record<string, string>>;

/** The sidecar's file name (issue #3 rule 8). */
export const SIDECAR_FILE = 'pitman.json';

/** A problem with one file, for the validation screen. */
export interface BundleIssue {
	readonly level: 'error' | 'warning';
	/** Path of the file (relative to the uploaded folder or zip). */
	readonly file: string;
	/** 1-based line, when known. */
	readonly line?: number;
	/** 1-based column, when known. */
	readonly column?: number;
	/** Line type and field, e.g. `L.002 rainfall file`, when known. */
	readonly field?: string;
	/** One sentence, without the location. */
	readonly message: string;
}

/**
 * Where each part of a loaded bundle came from, and the files it didn't
 * read. Round 3 addition (bundle.ts); a candidate for `types.ts` once a
 * second caller needs it.
 */
export interface BundleFileIndex {
	/** Folder holding the `.NET`, with a trailing `/`, or `''` at the top. */
	readonly root: string;
	/** Path of the `.NET`. */
	readonly network: string;
	/** Path of each module file, by `moduleKey` (`RU12`). */
	readonly modules: Readonly<Record<string, string>>;
	/** Paths by bundle key, one record per `NetworkBundle` record. */
	readonly rainfall: Readonly<Record<string, string>>;
	readonly observed: Readonly<Record<string, string>>;
	readonly flowFiles: Readonly<Record<string, string>>;
	/** Path of `pitman.json`, when there was one. */
	readonly sidecar?: string;
	/** Every file read above, verbatim, by path. */
	readonly sources: Readonly<Record<string, string>>;
	/** Every file no reader used, verbatim, by path. */
	readonly other: Readonly<Record<string, string>>;
}

/** A bundle read from files: the typed network plus where it came from. */
export interface LoadedBundle extends NetworkBundle {
	readonly files: BundleFileIndex;
}

interface ReadBundleCommon {
	readonly warnings: readonly BundleIssue[];
	/** Path of every `.NET` found, so a caller can offer a choice when there are several. */
	readonly networks: readonly string[];
}

/** The result of `readBundle`: the bundle, or every error found. */
export type ReadBundleResult =
	| (ReadBundleCommon & { readonly ok: true; readonly bundle: LoadedBundle; readonly errors: readonly [] })
	| (ReadBundleCommon & { readonly ok: false; readonly errors: readonly BundleIssue[] });

export interface ReadBundleOptions {
	/** Path of the `.NET` to read when the files hold more than one (case-insensitive). */
	readonly network?: string;
}

export interface WriteBundleOptions {
	/**
	 * Write an unchanged file back verbatim (default true). False writes
	 * every file through its writer, which normalises hand-made layouts
	 * (the reference suite uses it to measure the writers).
	 */
	readonly reuseUnchanged?: boolean;
}

/** The key a file is stored under in a `NetworkBundle` record: the name as given, trimmed and upper-cased. */
export function bundleKey(name: string): string {
	return name.trim().toUpperCase();
}

/** The key a module's file is stored under in `BundleFileIndex.modules`, e.g. `RU12`. */
export function moduleKey(module: Module): string {
	return `${module.kind === 'unparsed' ? module.moduleType : module.kind}${module.number}`;
}

/** Normalise a path: `/` separators, no leading `./` or `/`. */
function normalisePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

function dirName(path: string): string {
	const i = path.lastIndexOf('/');
	return i < 0 ? '' : path.slice(0, i + 1);
}

/** Whether a path is operating-system clutter that is never a network file (kept, but never read). */
function isClutter(path: string): boolean {
	return path.split('/').some((part) => part === '__MACOSX' || part.startsWith('._'));
}

const isNetworkFile = (path: string) => /\.NET$/i.test(path) && !isClutter(path);

/** The issue for an error a reader threw. */
function issueFrom(error: unknown, file: string): BundleIssue {
	if (error instanceof WrsmParseError) {
		return {
			level: 'error',
			file,
			line: error.line,
			...(error.column !== undefined && { column: error.column }),
			...(error.field !== undefined && { field: error.field }),
			message: error.detail
		};
	}
	return { level: 'error', file, message: error instanceof Error ? error.message : String(error) };
}

/** A warning for the first line holding a byte above 127 (docs/formats.md §1.1). */
function nonAsciiWarning(text: string, file: string): BundleIssue | undefined {
	if (!/[^\x00-\x7f]/.test(text)) return undefined;
	const lines = splitLines(text).lines;
	const line = lines.findIndex((l) => /[^\x00-\x7f]/.test(l)) + 1;
	return {
		level: 'warning',
		file,
		...(line > 0 && { line }),
		message: 'holds non-ASCII characters; WRSM2000 files are plain ASCII, so check this file was not changed by another program'
	};
}

/** Looks up names inside the network's root folder, case-insensitively (docs/formats.md §1.3). */
class FolderIndex {
	private readonly byPath = new Map<string, string>();
	private readonly byBase = new Map<string, string[]>();

	constructor(
		paths: readonly string[],
		private readonly root: string
	) {
		for (const path of paths) {
			if (!path.toUpperCase().startsWith(root.toUpperCase()) || isClutter(path)) continue;
			const rel = path.slice(root.length).toUpperCase();
			this.byPath.set(rel, path);
			const base = baseName(rel);
			this.byBase.set(base, [...(this.byBase.get(base) ?? []), path]);
		}
	}

	/**
	 * The file a name refers to and how it was found, or `undefined`.
	 * `direct`: the name as a path inside the root (an absolute name inside
	 * the `.NET`'s input directory, NET.2, counts as relative to it).
	 * `byName`: by base name, in the root or in the one file below it with
	 * that name (an absolute path elsewhere, or a relative one that isn't
	 * there): a guess, so the caller warns.
	 */
	resolve(name: string, inputDirectory = ''): { path: string; how: 'direct' | 'byName' } | undefined {
		let n = normalisePath(name.trim()).toUpperCase();
		if (n === '') return undefined;
		const dir = normalisePath(inputDirectory.trim()).toUpperCase().replace(/\/?$/, '/');
		const inInputDirectory = dir !== '/' && n.startsWith(dir);
		if (inInputDirectory) n = n.slice(dir.length);
		const absolute = !inInputDirectory && (/^[A-Z]:\//.test(n) || /^[\\/]/.test(name.trim()));
		if (!absolute) {
			const direct = this.byPath.get(n);
			if (direct !== undefined) return { path: direct, how: 'direct' };
		}
		const base = baseName(n);
		const top = this.byPath.get(base);
		if (top !== undefined) return { path: top, how: 'byName' };
		const anywhere = this.byBase.get(base);
		return anywhere?.length === 1 ? { path: anywhere[0] as string, how: 'byName' } : undefined;
	}
}

/** A file one module or the `.NET` refers to, and what it is. */
interface Reference {
	readonly name: string;
	readonly from: string;
	readonly field: string;
	/** A reference that is only a warning when its file is missing (a dummy wetland rainfall file). */
	readonly optional?: boolean;
}

function readModule(type: ModuleTypeCode, number: number, text: string, file: string): Module {
	switch (type) {
		case 'RU':
			return readRunoff(text, file);
		case 'RV':
			return readReservoir(text, file);
		case 'CR':
			return readChannel(text, file);
		case 'RR':
			return readIrrigation(text, file);
		case 'MM': {
			// No reader yet (docs/formats.md §9): kept verbatim and listed as not modelled.
			const lines = splitLines(text).lines.map((t, i) => ({ line: i + 1, text: t }));
			const unparsed: UnparsedModule = { kind: 'unparsed', moduleType: 'MM', number, name: '', reason: 'mine modules are not modelled yet', lines };
			return unparsed;
		}
	}
}

function writeModule(module: Module): string {
	switch (module.kind) {
		case 'RU':
			return writeRunoff(module);
		case 'RV':
			return writeReservoir(module);
		case 'CR':
			return writeChannel(module);
		case 'RR':
			return writeIrrigation(module);
		case 'unparsed':
			return joinLines(module.lines.map((l) => l.text));
	}
}

/** The files a module refers to (docs/formats.md §§5–8). */
function moduleReferences(module: Module, file: string): Reference[] {
	const out: Reference[] = [];
	const flows = (routes: readonly { route: number; definedFlowFile: string | null }[], line: string) => {
		for (const r of routes) {
			// '*' is a monthly defined abstraction held in the module file itself (TT 691 §12.3).
			if (r.definedFlowFile !== null && r.definedFlowFile.trim() !== '' && r.definedFlowFile.trim() !== '*') {
				out.push({ name: r.definedFlowFile, from: file, field: `${line} route ${r.route} defined-flow file` });
			}
		}
	};
	switch (module.kind) {
		case 'RU':
			out.push({ name: module.rainfallFile, from: file, field: 'L.002 rainfall file' });
			break;
		case 'RR':
			out.push({ name: module.rainfallFile, from: file, field: 'L.003 rainfall file' });
			break;
		case 'RV':
			out.push({ name: module.rainfallFile, from: file, field: 'L.002 rainfall file' });
			flows(module.inflows, 'L.011');
			flows(module.outflows, 'L.013');
			break;
		case 'CR':
			if (module.wetlandRainfallFile !== null) {
				out.push({ name: module.wetlandRainfallFile, from: file, field: 'L.002 wetland rainfall file', optional: module.wetlandType === 0 });
			}
			flows(module.inflows, 'L.008');
			flows(module.outflows, 'L.010');
			break;
		case 'unparsed':
			break;
	}
	return out;
}

/** Check a parsed `pitman.json` is a sidecar this version reads. */
function readSidecar(text: string): Sidecar {
	let value: unknown;
	try {
		// A byte-order mark is kept in the text (so the file saves unchanged) but isn't JSON.
		value = JSON.parse(text.replace(/^\uFEFF/, ''));
	} catch (error) {
		throw new Error(`is not valid JSON (${(error as Error).message})`);
	}
	const v = value as Partial<Sidecar> | null;
	if (typeof v !== 'object' || v === null || Array.isArray(v) || v.schema !== 'pitman-sidecar') {
		throw new Error("is not a Pitman sidecar (expected \"schema\": \"pitman-sidecar\")");
	}
	if (v.schemaVersion !== 1) throw new Error(`has sidecar schemaVersion ${String(v.schemaVersion)}; this version of Pitman reads 1`);
	return v as Sidecar;
}

/** Text of a sidecar as Pitman writes it: two-space JSON, LF, final newline. */
function writeSidecar(sidecar: Sidecar): string {
	return `${JSON.stringify(sidecar, null, 2)}\n`;
}

/**
 * Read a network folder. `files` maps relative paths to text (see the file
 * header for the encoding). Returns the bundle, or every error found.
 */
export function readBundle(files: BundleFiles, options: ReadBundleOptions = {}): ReadBundleResult {
	const errors: BundleIssue[] = [];
	const warnings: BundleIssue[] = [];
	const normalised = new Map<string, string>();
	for (const [path, text] of Object.entries(files)) normalised.set(normalisePath(path), text);
	const paths = [...normalised.keys()];
	const networks = paths.filter(isNetworkFile).sort();
	const fail = (issue: Omit<BundleIssue, 'level'>): ReadBundleResult => ({
		ok: false,
		errors: [{ level: 'error', ...issue }],
		warnings,
		networks
	});

	let netPath: string | undefined;
	if (options.network !== undefined) {
		const wanted = normalisePath(options.network).toUpperCase();
		netPath = networks.find((p) => p.toUpperCase() === wanted);
		if (netPath === undefined) return fail({ file: options.network, message: 'no such .NET file in the folder' });
	} else if (networks.length === 1) {
		netPath = networks[0];
	} else if (networks.length === 0) {
		return fail({ file: '(folder)', message: 'no network file (.NET) found; load the folder that holds the network' });
	} else {
		return fail({ file: '(folder)', message: `${networks.length} network files (.NET) found; choose one` });
	}
	netPath = netPath as string;

	const root = dirName(netPath);
	const index = new FolderIndex(paths, root);
	const sources: Record<string, string> = {};
	const used = new Set<string>();
	const take = (path: string): string => {
		const text = normalised.get(path) as string;
		if (!used.has(path)) {
			used.add(path);
			sources[path] = text;
			if (baseName(path).toLowerCase() !== SIDECAR_FILE) {
				const w = nonAsciiWarning(text, path);
				if (w) warnings.push(w);
			}
		}
		return text;
	};

	let network: Network;
	try {
		network = readNetwork(take(netPath), netPath);
	} catch (error) {
		return { ok: false, errors: [issueFrom(error, netPath)], warnings, networks };
	}

	// Module files: <code><TT><n>.DAT, in .NET order (docs/formats.md §1.3).
	const modules: Module[] = [];
	const modulePaths: Record<string, string> = {};
	const references: Reference[] = [];
	for (const entry of network.modules) {
		const name = `${network.code}${entry.type}${entry.number}.DAT`;
		const path = index.resolve(name)?.path;
		if (path === undefined) {
			errors.push({ level: 'error', file: `${root}${name}`, message: `module file not found; ${netPath} lists module ${entry.number}${entry.type}` });
			continue;
		}
		try {
			const module = readModule(entry.type, entry.number, take(path), path);
			if (module.number !== entry.number) {
				errors.push({
					level: 'error',
					file: path,
					line: 1,
					field: 'L.001 module number',
					message: `module number ${module.number} differs from ${entry.number} in the file name`
				});
				continue;
			}
			modules.push(module);
			modulePaths[moduleKey(module)] = path;
			references.push(...moduleReferences(module, path));
		} catch (error) {
			errors.push(issueFrom(error, path));
		}
	}

	// Files the modules and the gauges name, read once per key.
	// Every reference is checked (an optional one never hides a required one
	// to the same name); names that resolve to one file share one record.
	const readReferenced = <T>(refs: readonly Reference[], read: (text: string, file: string, ref: Reference) => T) => {
		const records: Record<string, T> = {};
		const recordPaths: Record<string, string> = {};
		const byKey = new Map<string, Reference[]>();
		for (const ref of refs) byKey.set(bundleKey(ref.name), [...(byKey.get(bundleKey(ref.name)) ?? []), ref]);
		const byPath = new Map<string, { value?: T }>();
		for (const [key, keyRefs] of byKey) {
			const required = keyRefs.find((r) => !r.optional);
			const ref = required ?? (keyRefs[0] as Reference);
			const found = index.resolve(ref.name, network.inputDirectory);
			if (found === undefined) {
				const issue = { file: ref.from, field: ref.field, message: `names '${ref.name.trim()}', which is not in the folder` };
				if (required) errors.push({ level: 'error', ...issue });
				else warnings.push({ level: 'warning', ...issue });
				continue;
			}
			const { path } = found;
			if (found.how === 'byName') {
				warnings.push({
					level: 'warning',
					file: ref.from,
					field: ref.field,
					message: `names '${ref.name.trim()}'; using ${path}, the file of that name in the folder`
				});
			}
			let cached = byPath.get(path);
			if (cached === undefined) {
				cached = {};
				byPath.set(path, cached);
				try {
					cached.value = read(take(path), path, ref);
				} catch (error) {
					const issue = issueFrom(error, path);
					// A dummy file (a type-0 wetland's rainfall) need not read.
					if (required) errors.push(issue);
					else warnings.push({ ...issue, level: 'warning', message: `${issue.message} (not used: the module has no wetland)` });
				}
			}
			if (cached.value !== undefined) {
				records[key] = cached.value;
				recordPaths[key] = path;
			}
		}
		return { records, recordPaths };
	};

	const isRainfall = (r: Reference) => r.field.includes('rainfall file');
	const rainfall = readReferenced<RainfallSeries>(references.filter(isRainfall), readRainfall);
	// A demand series records its name as the module gives it (DemandSeries.fileName).
	const flowFiles = readReferenced<DemandSeries>(references.filter((r) => !isRainfall(r)), (text, _path, ref) => readDemand(text, ref.name.trim()));
	const gaugeRefs = network.gauges.map((g, k) => ({ name: g.observedFile, from: netPath as string, field: `NET.11 gauge ${k + 1} observed file` }));
	const observed = readReferenced<ObservedFlow>(gaugeRefs, readObserved);

	let sidecar: Sidecar | undefined;
	const sidecarPath = index.resolve(SIDECAR_FILE)?.path;
	if (sidecarPath !== undefined && dirName(sidecarPath) === root) {
		try {
			sidecar = readSidecar(take(sidecarPath));
		} catch (error) {
			errors.push({ level: 'error', file: sidecarPath, message: (error as Error).message });
		}
	}

	if (errors.length > 0) return { ok: false, errors, warnings, networks };

	const other: Record<string, string> = {};
	for (const [path, text] of normalised) if (!used.has(path)) other[path] = text;
	const bundle: LoadedBundle = {
		network,
		modules,
		rainfall: rainfall.records,
		observed: observed.records,
		flowFiles: flowFiles.records,
		...(sidecar !== undefined && { sidecar }),
		files: {
			root,
			network: netPath,
			modules: modulePaths,
			rainfall: rainfall.recordPaths,
			observed: observed.recordPaths,
			flowFiles: flowFiles.recordPaths,
			...(sidecarPath !== undefined && sidecar !== undefined && { sidecar: sidecarPath }),
			sources,
			other
		}
	};
	return { ok: true, bundle, errors: [], warnings, networks };
}

/**
 * Structural equality for plain data (what readers return, and what survives
 * a structured clone or JSON): an absent key equals an `undefined` one.
 */
export function sameData(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const bb = b as unknown[];
		return a.length === bb.length && a.every((x, i) => sameData(x, bb[i]));
	}
	const ra = a as Record<string, unknown>;
	const rb = b as Record<string, unknown>;
	const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
	for (const k of keys) if (!sameData(ra[k], rb[k])) return false;
	return true;
}

function hasFileIndex(bundle: NetworkBundle): bundle is LoadedBundle {
	return typeof (bundle as Partial<LoadedBundle>).files === 'object' && (bundle as Partial<LoadedBundle>).files !== null;
}

/** A file name for a new record from its key (`RAIN\\X.RAN` → `RAIN/X.RAN`); never outside the root. */
function pathFromKey(root: string, key: string): string {
	const n = normalisePath(key);
	const rel = /^[A-Z]:\//i.test(n) ? baseName(n) : n;
	if (rel.split('/').some((part) => part === '..' || part === '')) throw new Error(`${key}: not a file name inside the network folder`);
	return root + rel;
}

/**
 * Write a bundle back to files: path → text, in the encoding `readBundle`
 * takes. A bundle from `readBundle` keeps its paths and every file it
 * didn't read; a bundle built in code gets `<code>.NET`,
 * `<code><TT><n>.DAT`, each record under its key, and `pitman.json`.
 * Throws an `Error` naming the file when a writer can't write a value.
 */
export function writeBundle(bundle: NetworkBundle, options: WriteBundleOptions = {}): Record<string, string> {
	const reuse = options.reuseUnchanged !== false;
	const index = hasFileIndex(bundle) ? bundle.files : undefined;
	const root = index?.root ?? '';
	const out: Record<string, string> = { ...(index?.other ?? {}) };
	const written = new Set<string>();
	// A new record keeps the spelling of a file already there under another case (docs/formats.md §1.3).
	const existing = new Map<string, string>();
	for (const p of [...Object.keys(index?.other ?? {}), ...Object.keys(index?.sources ?? {})]) existing.set(p.toUpperCase(), p);
	const newPath = (path: string) => existing.get(path.toUpperCase()) ?? path;

	const put = <T>(path: string, value: T, write: (v: T) => string, read: (text: string, file: string) => T) => {
		const source = index?.sources[path];
		let text: string | undefined;
		if (reuse && source !== undefined) {
			try {
				if (sameData(read(source, path), value)) text = source;
			} catch {
				// The source no longer reads (it can't have, or readBundle would have failed): write the value.
			}
		}
		if (text === undefined) {
			try {
				text = write(value);
			} catch (error) {
				throw new Error(`${path}: ${(error as Error).message}`);
			}
		}
		if (written.has(path) && out[path] !== text) {
			throw new Error(`${path}: two records would write different contents to this file`);
		}
		written.add(path);
		out[path] = text;
	};

	const { code } = bundle.network;
	put(index?.network ?? newPath(`${root}${code}.NET`), bundle.network, writeNetwork, readNetwork);
	for (const module of bundle.modules) {
		const key = moduleKey(module);
		const path = index?.modules[key] ?? newPath(`${root}${code}${key.slice(0, 2)}${module.number}.DAT`);
		put(path, module, writeModule, (text, file) =>
			readModule(module.kind === 'unparsed' ? module.moduleType : module.kind, module.number, text, file)
		);
	}
	for (const [key, series] of Object.entries(bundle.rainfall)) {
		put(index?.rainfall[key] ?? newPath(pathFromKey(root, key)), series, writeRainfall, readRainfall);
	}
	for (const [key, flow] of Object.entries(bundle.observed)) {
		put(index?.observed[key] ?? newPath(pathFromKey(root, key)), flow, writeObserved, readObserved);
	}
	for (const [key, series] of Object.entries(bundle.flowFiles)) {
		// readDemand records the name it is given: re-read under the same one.
		put(index?.flowFiles[key] ?? newPath(pathFromKey(root, key)), series, writeDemand, (text) => readDemand(text, series.fileName));
	}
	if (bundle.sidecar !== undefined) {
		put(index?.sidecar ?? newPath(`${root}${SIDECAR_FILE}`), bundle.sidecar, writeSidecar, readSidecar);
	}
	return out;
}
