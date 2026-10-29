import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NET_DIRECTORY_WIDTH, readNetwork, writeNetwork } from './network.js';
import { WrsmParseError } from './tokens.js';

// Synthetic inputs only: docs/formats/examples/ is an invented network.

const example = readFileSync(new URL('../../../../docs/formats/examples/network/SY.NET', import.meta.url), 'latin1');
const lines = example.split('\r\n');
const withLines = (edit: (lines: string[]) => void) => {
	const copy = [...lines];
	edit(copy);
	return copy.join('\r\n');
};

function parseError(text: string): WrsmParseError {
	try {
		readNetwork(text, 'SY.NET');
	} catch (error) {
		if (error instanceof WrsmParseError) return error;
		throw error;
	}
	throw new Error('expected a parse error');
}

describe('readNetwork on the synthetic example', () => {
	const network = readNetwork(example, 'SY.NET');

	it('reads the header lines', () => {
		expect(network.code).toBe('SY');
		expect(network.fileVersion).toBe(1);
		expect(network.inputDirectory).toBe('C:\\WRSM\\SY\\');
		expect(network.outputDirectory).toBe('C:\\WRSM\\SY\\Out\\');
		expect(network.directoryLineWidths).toBeUndefined();
		expect(network.debug).toBe('N');
		expect(network.summaryFile).toBe(false);
	});

	it('reads the module list in solution order', () => {
		expect(network.modules).toHaveLength(8);
		expect(network.modules[0]).toEqual({ number: 1, type: 'RU', solve: true });
		expect(network.modules[1]).toEqual({ number: 11, type: 'RU', solve: true });
		expect(network.modules.map((m) => m.type)).toEqual(['RU', 'RU', 'RU', 'RU', 'RR', 'RV', 'CR', 'RV']);
	});

	it('reads the gauge with its label unpadded', () => {
		expect(network.gauges).toEqual([{ route: 9, label: 'SYH001', observedFile: 'SYH001.obs' }]);
	});

	it('reads the period, routes and summary count', () => {
		expect([network.startYear, network.endYear]).toEqual([1990, 1994]);
		expect(network.routes).toHaveLength(12);
		expect(network.routes[0]).toEqual({ number: 1, upstreamPosition: 1, downstreamPosition: 6, cost: 0 });
		expect(network.routes[2]).toEqual({ number: 3, upstreamPosition: 2, downstreamPosition: 0, cost: 0 });
		expect(network.summaryLines).toEqual([]);
	});

	it('writes the file back byte for byte', () => {
		expect(writeNetwork(network)).toBe(example);
	});
});

describe('writeNetwork layout', () => {
	const network = readNetwork(example, 'SY.NET');

	it('pads the directory lines to 287 columns', () => {
		const out = writeNetwork({ ...network, inputDirectory: 'D:\\Other dir\\' }).split('\r\n');
		expect(out[1]).toHaveLength(NET_DIRECTORY_WIDTH);
		expect(out[1]?.trimEnd()).toBe('D:\\Other dir\\');
	});

	it('keeps a hand-edited padding width', () => {
		const text = withLines((l) => {
			l[1] = 'C:\\X\\'.padEnd(210);
			l[2] = 'C:\\X\\Out\\'.padEnd(214);
		});
		const read = readNetwork(text, 'SY.NET');
		expect(read.inputDirectory).toBe('C:\\X\\');
		expect(read.directoryLineWidths).toEqual({ input: 210, output: 214 });
		expect(writeNetwork(read)).toBe(text);
	});

	it('pads gauge labels to 20 inside the quotes and escapes quotes', () => {
		const out = writeNetwork({ ...network, gauges: [{ route: 9, label: "A'B", observedFile: 'x.obs' }] }).split('\r\n');
		const at = out.indexOf(`   9 'A''B${' '.repeat(17)}'`);
		expect(at).toBeGreaterThan(0);
		expect(out[at + 1]).toBe("'x.obs'");
	});

	it('writes summary lines single-spaced (U-7) and reads them back', () => {
		const text = writeNetwork({ ...network, summaryLines: [{ kind: 'RT', number: 9, quantity: 'Q' }] });
		expect(text.endsWith("    1\r\n'RT' 9 'Q'\r\n")).toBe(true);
		expect(readNetwork(text, 'SY.NET').summaryLines).toEqual([{ kind: 'RT', number: 9, quantity: 'Q' }]);
	});

	it('rejects a value too wide for its field', () => {
		expect(() => writeNetwork({ ...network, routes: [{ number: 1234567, upstreamPosition: 1, downstreamPosition: 0, cost: 0 }] })).toThrow(
			/NET.14 route.*I6/
		);
	});
});

describe('readNetwork errors name the file, line and field', () => {
	it('rejects a WRSM90 file without a storage version', () => {
		const e = parseError(withLines((l) => (l[0] = 'SY')));
		expect([e.file, e.line, e.field]).toEqual(['SY.NET', 1, 'NET.1 version']);
		expect(e.message).toMatch(/WRSM90/);
	});

	it('rejects an obsolete debug flag', () => {
		const e = parseError(withLines((l) => (l[3] = 'D')));
		expect([e.line, e.field]).toEqual([4, 'NET.4']);
	});

	it('rejects a malformed module entry', () => {
		const e = parseError(withLines((l) => (l[7] = '11XXY   ')));
		expect([e.line, e.field]).toEqual([8, 'NET.8']);
	});

	it('rejects a non-integer count with its column', () => {
		const e = parseError(withLines((l) => (l[5] = '   x')));
		expect([e.line, e.column, e.field]).toEqual([6, 4, 'NET.7 count']);
	});

	it('rejects a duplicate route', () => {
		const e = parseError(withLines((l) => (l[20] = '     1     2     7     0')));
		expect([e.line, e.field]).toEqual([21, 'NET.14 route']);
	});

	it('rejects a sink index past the module list', () => {
		const e = parseError(withLines((l) => (l[19] = '     1     1     9     0')));
		expect([e.line, e.field]).toEqual([20, 'NET.14 sink']);
		expect(e.message).toMatch(/0–8/);
	});

	it('rejects a gauge on an undefined route', () => {
		const e = parseError(withLines((l) => (l[15] = "  99 'SYH001              '")));
		expect([e.line, e.field]).toEqual([16, 'NET.10 route']);
	});

	it('reports a file cut short', () => {
		const e = parseError(lines.slice(0, 22).join('\r\n'));
		expect(e.field).toBe('NET.14');
		expect(e.message).toMatch(/end of file/);
	});

	it('rejects text after the last line', () => {
		const e = parseError(example + 'junk\r\n');
		expect(e.field).toBe('end');
	});
});
