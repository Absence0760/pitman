// docs/STACK.md: nothing reachable from the Lambda entry may import dotenv (server.ts loads it for local
// dev only). Bundles lambda.ts as `pnpm build` does and checks what went in: no dotenv, no synthetic-data
// writer, and @aws-sdk/client-s3 present for the S3 copy.
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('the Lambda bundle', () => {
	it('leaves out dotenv and the synthetic copy’s writers', async () => {
		const r = await build({
			entryPoints: [new URL('./lambda.ts', import.meta.url).pathname],
			bundle: true,
			platform: 'node',
			target: 'node20',
			format: 'esm',
			write: false,
			metafile: true,
			logLevel: 'silent'
		});
		const inputs = Object.keys(r.metafile.inputs);
		expect(inputs.some((p) => p.includes('/dotenv/'))).toBe(false);
		expect(inputs.some((p) => p.endsWith('server.ts'))).toBe(false);
		expect(inputs.some((p) => /chirps\/(synthetic|mirror\/writers)\.ts$/.test(p) || p.endsWith('mapgrid/synthetic.ts') || p.endsWith('delineation/syntheticDem.ts'))).toBe(false);
		expect(inputs.some((p) => p.includes('@aws-sdk/client-s3'))).toBe(true);
	}, 30_000);
});
