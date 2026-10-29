import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guard for issue #3 rule 6: the engine has no I/O, DOM or Node APIs.
// tsconfig.json already fails the typecheck on Node or DOM globals (no
// `types`, no DOM `lib`); this catches imports and globals by text too, so
// a stray `// @ts-ignore` can't slip one through.

const srcDir = fileURLToPath(new URL('.', import.meta.url));

function engineSources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return engineSources(path);
		return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
	});
}

const NODE_MODULES = [
	'fs', 'path', 'os', 'url', 'child_process', 'process', 'buffer', 'stream', 'http', 'https', 'net',
	'crypto', 'zlib', 'worker_threads', 'util', 'events', 'readline', 'module', 'vm'
];

const FORBIDDEN: readonly [string, RegExp][] = [
	['a node: import', /\bfrom\s+['"]node:|\bimport\s*\(\s*['"]node:|\brequire\s*\(\s*['"]node:/],
	['a Node built-in import', new RegExp(`\\bfrom\\s+['"](?:${NODE_MODULES.join('|')})(?:/[^'"]*)?['"]`)],
	['require()', /\brequire\s*\(/],
	['a Node global', /\b(?:process|Buffer|__dirname|__filename)\s*[.[(]/],
	['a DOM global', /\b(?:window|document|localStorage|indexedDB|fetch|XMLHttpRequest)\s*[.(]/]
];

describe('engine purity', () => {
	const files = engineSources(srcDir);

	it('finds the engine sources', () => {
		expect(files.map((f) => relative(srcDir, f))).toEqual(expect.arrayContaining(['index.ts', 'types.ts', join('io', 'tokens.ts')]));
	});

	it.each(files.map((f) => [relative(srcDir, f), f]))('%s uses no Node, DOM or I/O APIs', (_name, file) => {
		const text = readFileSync(file, 'utf8')
			// Ignore comments, which may mention these APIs.
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
		for (const [what, pattern] of FORBIDDEN) {
			expect(pattern.test(text), `${what} in ${file}`).toBe(false);
		}
	});
});
