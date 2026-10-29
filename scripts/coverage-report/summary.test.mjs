// Tests for summary.mjs (node --test). Copied from IC-WBT's scripts/coverage-report/summary.test.mjs (MIT, same author).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from './summary.mjs';

const m = (covered, total) => ({ total, covered, skipped: 0, pct: total ? Math.round((covered / total) * 10000) / 100 : 100 });
const file = (lc, lt) => ({ lines: m(lc, lt), statements: m(lc, lt), functions: m(1, 1), branches: m(1, 1) });

test('a row per report, then each report’s files with the most unreached lines, worst first', () => {
	const summary = {
		total: { lines: m(70, 100), statements: m(70, 100), functions: m(9, 10), branches: m(3, 4) },
		'/r/backend/src/a.ts': file(10, 40),
		'/r/backend/src/b.ts': file(50, 50),
		'/r/backend/src/c.ts': file(10, 10 + 30)
	};
	const out = render([{ name: 'backend (unit)', summary }], '/r', 15);
	assert.match(out, /\| backend \(unit\) \| 70% \| 75% \| 90% \|/);
	const rows = out.split('\n').filter((l) => l.startsWith('| `'));
	// a.ts and c.ts both miss 30 lines: the tie sorts by path. b.ts misses none, so it isn't listed.
	assert.deepEqual(rows, ['| `backend/src/a.ts` | 30 | 25% |', '| `backend/src/c.ts` | 30 | 25% |']);
});

test('lists at most `top` files and leaves out a report with nothing unreached', () => {
	const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`/r/f${i}.ts`, file(0, i + 1)]));
	const full = { total: { lines: m(1, 1), statements: m(1, 1), functions: m(1, 1), branches: m(1, 1) } };
	const out = render(
		[
			{ name: 'one', summary: { total: full.total, ...files } },
			{ name: 'two', summary: full }
		],
		'/r',
		2
	);
	assert.deepEqual(
		out.split('\n').filter((l) => l.startsWith('| `')),
		['| `f4.ts` | 5 | 0% |', '| `f3.ts` | 4 | 0% |']
	);
	assert.doesNotMatch(out, /### two/);
});
