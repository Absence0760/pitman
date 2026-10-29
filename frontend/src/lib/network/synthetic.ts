/**
 * A synthetic network as files and as a zip, for tests (unit tests here and
 * the end-to-end test: load → run each mode → save → reload). Built from the
 * engine's `syntheticNetwork()` (three runoff modules into a channel reach)
 * plus the channel reach itself, which that generator lists in the `.NET`
 * only. Invented values only (issue #3 rule 2).
 */

import { readChannel, syntheticNetwork, type NetworkBundle, type SyntheticOptions } from '@pitman/wrsm';
import { bundleKey, writeBundle } from './engine.js';
import { packZip } from './zip.js';

/** Channel reach CR4: routes 2 and 3 in, route 4 out, no wetland (layout as docs/formats/examples/network/SYCR5.DAT). */
function channelText(): string {
	const lines = [
		"4 'Synthetic reach'   2",
		"     0. ' '",
		'   0.00    1.00    1.00    1.00',
		' 160.00  150.00  140.00  150.00  130.00  120.00   90.00   70.00   60.00   65.00   85.00  120.00',
		' 0.8000  0.8200  0.8400  0.8500  0.8600  0.8600  0.8600  0.8500  0.8400  0.8200  0.8000  0.8000',
		'4    ',
		'2    ',
		"2 ' '",
		"3 ' '",
		'1    ',
		"4 ' '",
		'   1   0',
		'    0.000     0.000     0.600     0.000     0.000     0.000',
		'  0.000',
		'   0',
		'   0',
		'   0',
		'    0.000     0.000     0.000'
	];
	return lines.map((l) => `${l}\r\n`).join('');
}

/** The synthetic network as a bundle every module of which has a file. */
export function syntheticBundle(options: SyntheticOptions = {}): NetworkBundle {
	const net = syntheticNetwork(options);
	const code = net.network.code;
	return {
		network: net.network,
		modules: [...net.runoff, readChannel(channelText(), `${code}CR4.DAT`)],
		rainfall: Object.fromEntries(net.rainfall.map((r) => [bundleKey(r.fileName), r.series])),
		observed: {},
		flowFiles: {}
	};
}

export interface SyntheticFilesOptions extends SyntheticOptions {
	/** Folder to put the files in (`SY/`), default none. */
	readonly folder?: string;
}

/** The synthetic network's files, path → text. */
export function syntheticNetworkFiles(options: SyntheticFilesOptions = {}): Record<string, string> {
	const files = writeBundle(syntheticBundle(options));
	const prefix = options.folder ? `${options.folder.replace(/\/+$/, '')}/` : '';
	return Object.fromEntries(Object.entries(files).map(([p, t]) => [prefix + p, t]));
}

/** The synthetic network as a zip (entry dates fixed, so the bytes are reproducible). */
export function syntheticNetworkZip(options: SyntheticFilesOptions = {}): Uint8Array {
	return packZip(syntheticNetworkFiles(options), { mtime: new Date('2025-01-01T00:00:00Z') });
}
