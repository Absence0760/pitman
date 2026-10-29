/**
 * The network file (.NET), TT 691 §12.6 pp.182–184 and docs/formats.md §4.
 * Read line by line in this order and only this order (the manual's line
 * numbering, so NET.5 and NET.16 are usually absent):
 *
 * | Line | Fields | Written as |
 * |---|---|---|
 * | NET.1 | network code; storage version | `A3,I4` → `SY    1` |
 * | NET.2, NET.3 | input, output directory | text blank-padded to 287 columns (U-6) |
 * | NET.4 | debug flag | `N` (D/Y are obsolete and rejected) |
 * | NET.6 | summary flag Y/N | `A1` |
 * | NET.7, NET.8 ×M | module count; `<n><TT><Y/N>` | `I4`; `A8` |
 * | NET.9, NET.10–11 ×G | gauge count; route + label; observed file | `I4`; `I4,1X,'A20'`; `'name'` |
 * | NET.12 | start, end year | `I4,1X,I4` |
 * | NET.13, NET.14 ×R | route count; number, source, sink, cost | `I4`; `4I6` |
 * | NET.15, NET.16 ×S | summary count; `'RT' n 'Q'` | `I5`; free format (U-7) |
 *
 * Route endpoints are 1-based positions in the module list, 0 = outside the
 * network (TT 691 L.014; docs/decisions.md "Routes").
 */

import type { Gauge, ModuleTypeCode, Network, NetworkModuleEntry, Route, SummaryLine } from '../types.js';
import { formatI, joinLines } from './series.js';
import { FieldCursor, WrsmParseError, splitLines, tokenizeLine } from './tokens.js';

/** WRSM2000 pads the directory lines to this many columns (U-6). */
export const NET_DIRECTORY_WIDTH = 287;

const MODULE_ENTRY = /^(\d{1,4})(RU|RV|RR|CR|MM)([YN])$/;

/** Read a .NET file. Errors name the file, line, column and field (e.g. `NET.14 sink`). */
export function readNetwork(text: string, fileName: string): Network {
	const lines = splitLines(text).lines;
	let next = 0;
	const options = { file: fileName };
	const take = (lineType: string): { text: string; cursor: FieldCursor } => {
		if (next >= lines.length) {
			throw new WrsmParseError(`expected ${lineType}, found end of file`, { file: fileName, line: next + 1, field: lineType });
		}
		const text = lines[next] as string;
		next++;
		return { text, cursor: new FieldCursor(tokenizeLine(text, next, options), options) };
	};
	const fail = (detail: string, lineType: string, column = 1) =>
		new WrsmParseError(detail, { file: fileName, line: next, column, field: lineType });
	const count = (lineType: string) => {
		const { cursor } = take(lineType);
		const n = cursor.integer(`${lineType} count`);
		cursor.end(lineType);
		if (n < 0) throw fail(`negative count ${n}`, lineType);
		return n;
	};
	const flag = (lineType: string, allowed: readonly string[]) => {
		const { cursor } = take(lineType);
		const value = cursor.word(lineType).toUpperCase();
		cursor.end(lineType);
		if (!allowed.includes(value)) throw fail(`expected ${allowed.join(' or ')}, found '${value}'`, lineType);
		return value;
	};

	// NET.1: `A3,I4`. A file without the version is WRSM90's format.
	const firstLine = take('NET.1').cursor.tokenLine;
	const [codeToken, versionToken, extra] = firstLine.tokens;
	if (codeToken === undefined) throw fail('expected the network code', 'NET.1 code');
	const code = codeToken.text;
	if (code.length > 3) throw fail(`network code '${code}' is longer than 3 characters`, 'NET.1 code');
	if (versionToken === undefined) {
		throw fail('no storage version: a WRSM90 network file; convert it in WRSM2000 first', 'NET.1 version');
	}
	if (versionToken.kind !== 'number' || !versionToken.integer) {
		throw fail(`expected an integer, found '${versionToken.text}'`, 'NET.1 version', versionToken.column);
	}
	if (extra !== undefined) throw fail(`unexpected '${extra.text}' at end of NET.1`, 'NET.1', extra.column);
	const fileVersion = versionToken.value;

	// NET.2, NET.3: free text, trailing padding removed.
	const input = take('NET.2').text;
	const output = take('NET.3').text;
	const inputDirectory = input.trimEnd();
	const outputDirectory = output.trimEnd();

	// NET.4 (NET.5 only follows an obsolete D/Y), NET.6
	const debug = flag('NET.4', ['N', 'D', 'Y']);
	if (debug !== 'N') throw fail(`debug flag '${debug}' is obsolete and not supported (TT 691 p.183)`, 'NET.4');
	const summaryFile = flag('NET.6', ['Y', 'N']) === 'Y';

	// NET.7, NET.8
	const moduleCount = count('NET.7');
	const modules: NetworkModuleEntry[] = [];
	for (let i = 0; i < moduleCount; i++) {
		const { text } = take('NET.8');
		const m = MODULE_ENTRY.exec(text.trim());
		if (m === null) throw fail(`expected a module entry like '12RUY', found '${text.trim().slice(0, 40)}'`, 'NET.8');
		modules.push({ number: Number(m[1]), type: m[2] as ModuleTypeCode, solve: m[3] === 'Y' });
	}

	// NET.9, NET.10, NET.11
	const gaugeCount = count('NET.9');
	const gauges: Gauge[] = [];
	const gaugeLines: number[] = [];
	for (let i = 0; i < gaugeCount; i++) {
		const { cursor } = take('NET.10');
		gaugeLines.push(next);
		const route = cursor.integer('NET.10 route');
		const label = cursor.string('NET.10 label').trimEnd();
		cursor.end('NET.10');
		const file = take('NET.11').cursor;
		const observedFile = file.string('NET.11 observed file');
		file.end('NET.11');
		gauges.push({ route, label, observedFile });
	}

	// NET.12
	const period = take('NET.12').cursor;
	const startYear = period.integer('NET.12 start year');
	const endYear = period.integer('NET.12 end year');
	period.end('NET.12');
	if (endYear < startYear) throw fail(`end year ${endYear} is before start year ${startYear}`, 'NET.12');

	// NET.13, NET.14
	const routeCount = count('NET.13');
	const routes: Route[] = [];
	const seen = new Set<number>();
	for (let i = 0; i < routeCount; i++) {
		const { cursor } = take('NET.14');
		const number = cursor.integer('NET.14 route');
		const upstreamPosition = cursor.integer('NET.14 source');
		const downstreamPosition = cursor.integer('NET.14 sink');
		const cost = cursor.integer('NET.14 cost');
		cursor.end('NET.14');
		if (seen.has(number)) throw fail(`duplicate route ${number}`, 'NET.14 route');
		seen.add(number);
		for (const [position, field] of [
			[upstreamPosition, 'source'],
			[downstreamPosition, 'sink']
		] as const) {
			if (position < 0 || position > modules.length) {
				throw fail(`${field} index ${position} is outside the module list (0–${modules.length})`, `NET.14 ${field}`);
			}
		}
		routes.push({ number, upstreamPosition, downstreamPosition, cost });
	}

	// NET.15, NET.16
	const summaryCount = count('NET.15');
	const summaryLines: SummaryLine[] = [];
	for (let i = 0; i < summaryCount; i++) {
		const { cursor } = take('NET.16');
		const kind = cursor.string('NET.16 kind').toUpperCase();
		if (kind !== 'RT' && kind !== 'RV') throw fail(`expected 'RT' or 'RV', found '${kind}'`, 'NET.16 kind');
		const number = cursor.integer('NET.16 number');
		const quantity = cursor.string('NET.16 quantity');
		cursor.end('NET.16');
		summaryLines.push({ kind, number, quantity });
	}

	for (; next < lines.length; next++) {
		if ((lines[next] as string).trim() !== '') {
			next++;
			throw fail('unexpected text after the last line (NET.15/NET.16)', 'end');
		}
	}

	gauges.forEach((gauge, i) => {
		if (!seen.has(gauge.route)) {
			throw new WrsmParseError(`gauge '${gauge.label}' is on route ${gauge.route}, which is not defined`, {
				file: fileName,
				line: gaugeLines[i] ?? 1,
				field: 'NET.10 route'
			});
		}
	});

	const network: Network = {
		code,
		fileVersion,
		inputDirectory,
		outputDirectory,
		debug,
		summaryFile,
		modules,
		gauges,
		startYear,
		endYear,
		routes,
		summaryLines
	};
	if (input.length === NET_DIRECTORY_WIDTH && output.length === NET_DIRECTORY_WIDTH) return network;
	return { ...network, directoryLineWidths: { input: input.length, output: output.length } };
}

function quote(text: string): string {
	return `'${text.replace(/'/g, "''")}'`;
}

/** Write a .NET file in WRSM2000's layout (see the file header), CRLF throughout. */
export function writeNetwork(network: Network): string {
	if (network.debug !== 'N') throw new RangeError(`debug flag '${network.debug}' is obsolete and not supported`);
	if (network.code.length < 1 || network.code.length > 3) {
		throw new RangeError(`network code '${network.code}' must be 1–3 characters`);
	}
	const widths = network.directoryLineWidths ?? { input: NET_DIRECTORY_WIDTH, output: NET_DIRECTORY_WIDTH };
	const lines: string[] = [
		network.code.padEnd(3) + formatI(network.fileVersion, 4, 'NET.1 version'),
		network.inputDirectory.padEnd(widths.input),
		network.outputDirectory.padEnd(widths.output),
		network.debug,
		network.summaryFile ? 'Y' : 'N',
		formatI(network.modules.length, 4, 'NET.7 count'),
		...network.modules.map((m) => `${m.number}${m.type}${m.solve ? 'Y' : 'N'}`.padEnd(8)),
		formatI(network.gauges.length, 4, 'NET.9 count')
	];
	for (const gauge of network.gauges) {
		lines.push(`${formatI(gauge.route, 4, 'NET.10 route')} ${quote(gauge.label.padEnd(20))}`, quote(gauge.observedFile));
	}
	lines.push(
		`${formatI(network.startYear, 4, 'NET.12 start year')} ${formatI(network.endYear, 4, 'NET.12 end year')}`,
		formatI(network.routes.length, 4, 'NET.13 count'),
		...network.routes.map(
			(r) =>
				formatI(r.number, 6, 'NET.14 route') +
				formatI(r.upstreamPosition, 6, 'NET.14 source') +
				formatI(r.downstreamPosition, 6, 'NET.14 sink') +
				formatI(r.cost, 6, 'NET.14 cost')
		),
		formatI(network.summaryLines.length, 5, 'NET.15 count'),
		...network.summaryLines.map((s) => `${quote(s.kind)} ${s.number} ${quote(s.quantity)}`)
	);
	return joinLines(lines);
}
