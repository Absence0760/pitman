import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syntheticNetwork, type RunoffModule, type SyntheticNetwork } from '@pitman/wrsm';

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
 * Write a synthetic network to a new temp folder as JSON "files" for the
 * fake engine. RU3's file is stored in lower case to exercise the
 * case-insensitive lookup. `edit` may change the objects first.
 */
export async function writeSyntheticNetwork(
	edit: (net: { network: SyntheticNetwork['network']; runoff: RunoffModule[]; rainfall: SyntheticNetwork['rainfall'] }) => void = () => {}
): Promise<{ dir: string; synthetic: SyntheticNetwork }> {
	const base = syntheticNetwork({ seed: 11, years: 4 });
	const synthetic = { network: base.network, runoff: [...base.runoff], rainfall: base.rainfall };
	edit(synthetic);
	const dir = await mkdtemp(join(tmpdir(), 'wrsm-cli-'));
	const code = synthetic.network.code;
	await writeFile(join(dir, `${code}.NET`), JSON.stringify(synthetic.network));
	for (const module of synthetic.runoff) {
		const name = module.number === 3 ? `${code}RU3.dat`.toLowerCase() : `${code}RU${module.number}.DAT`;
		await writeFile(join(dir, name), JSON.stringify(module));
	}
	for (const file of synthetic.rainfall) await writeFile(join(dir, file.fileName), JSON.stringify(file.series));
	return { dir, synthetic };
}
