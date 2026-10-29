#!/usr/bin/env node
// Coverage summary (docs/STACK.md § Commands): reads each workspace's vitest
// json-summary report (`pnpm test:coverage`) and prints Markdown: one row per
// report, then the files with the most lines no test reaches. The weekly
// Coverage workflow writes it to the run's summary. A report, never a gate:
// it exits 0 whatever the numbers, and 1 only when no report exists at all.
// Adapted from IC-WBT's scripts/coverage-report/summary.mjs (MIT, same author).
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const REPORTS = [
	{ name: 'engine (packages/wrsm)', dir: 'packages/wrsm/coverage' },
	{ name: 'CLI (packages/wrsm-cli)', dir: 'packages/wrsm-cli/coverage' },
	{ name: 'backend', dir: 'backend/coverage' },
	{ name: 'frontend', dir: 'frontend/coverage' }
];

const pct = (m) => `${m.pct}%`;

/** The Markdown for the reports found: `found` is [{ name, summary }] with summary the parsed coverage-summary.json. */
export function render(found, root, top = 15) {
	const lines = ['## Coverage', '', '| Report | Lines | Branches | Functions |', '| --- | ---: | ---: | ---: |'];
	for (const { name, summary } of found) lines.push(`| ${name} | ${pct(summary.total.lines)} | ${pct(summary.total.branches)} | ${pct(summary.total.functions)} |`);
	for (const { name, summary } of found) {
		const files = Object.entries(summary)
			.filter(([k, m]) => k !== 'total' && m.lines.total > m.lines.covered)
			.map(([k, m]) => ({ file: relative(root, k), missed: m.lines.total - m.lines.covered, lines: m.lines }))
			.sort((a, b) => b.missed - a.missed || a.file.localeCompare(b.file))
			.slice(0, top);
		if (!files.length) continue;
		lines.push('', `### ${name}: most lines no test reaches`, '', '| File | Lines not reached | Lines |', '| --- | ---: | ---: |');
		for (const f of files) lines.push(`| \`${f.file}\` | ${f.missed} | ${pct(f.lines)} |`);
	}
	return lines.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const root = new URL('../..', import.meta.url).pathname;
	const found = REPORTS.map((r) => ({ ...r, path: join(root, r.dir, 'coverage-summary.json') }))
		.filter((r) => existsSync(r.path))
		.map((r) => ({ name: r.name, summary: JSON.parse(readFileSync(r.path, 'utf8')) }));
	if (!found.length) {
		console.error('No coverage report found: run pnpm test:coverage first.');
		process.exit(1);
	}
	process.stdout.write(render(found, root));
}
