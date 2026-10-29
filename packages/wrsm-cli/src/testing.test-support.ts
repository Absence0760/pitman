import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { syntheticBundle, writeBundle, type NetworkBundle } from '@pitman/wrsm';

/** Captured CLI output. */
export function capture() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
		out,
		err,
		text: () => out.join('') + err.join('')
	};
}

/**
 * Write the engine's synthetic network (three runoff modules, irrigation, a
 * reservoir, a channel reach, a gauge, defined flows) to a new temp folder in
 * WRSM2000's formats. RU3's file is stored in lower case to exercise the
 * case-insensitive lookup. `edit` may change the files first.
 */
export async function writeSyntheticNetwork(
	edit: (files: Record<string, string>) => void = () => {}
): Promise<{ dir: string; bundle: NetworkBundle; files: Record<string, string> }> {
	const bundle = syntheticBundle({ seed: 11, years: 4 });
	const files = { ...writeBundle(bundle) };
	const ru3 = Object.keys(files).find((p) => p.toUpperCase() === 'SYRU3.DAT');
	if (ru3) {
		files[ru3.toLowerCase()] = files[ru3]!;
		delete files[ru3];
	}
	edit(files);
	const dir = await mkdtemp(join(tmpdir(), 'wrsm-cli-'));
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), text, 'latin1');
	}
	return { dir, bundle, files };
}
