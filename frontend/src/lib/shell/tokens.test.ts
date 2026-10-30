/**
 * Guards for the design tokens (docs/design/ui-playbook.md): text and marks
 * keep their contrast in both themes, and components take colours from the
 * tokens, so the dark theme can't be missed by a raw hex.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..');
const css = readFileSync(join(SRC, 'app.css'), 'utf8');

function tokens(block: string): Record<string, string> {
	return Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/g)].map((m) => [m[1] as string, m[2] as string]));
}

const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const light = tokens(css.slice(0, darkStart));
const dark = { ...light, ...tokens(css.slice(darkStart, css.indexOf('@media (pointer: fine)'))) };

function luminance(hex: string): number {
	const channel = (i: number) => {
		const v = parseInt(hex.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

const TEXT_PAIRS: readonly (readonly [string, string])[] = [
	['--text', '--bg'],
	['--text', '--surface'],
	['--text', '--surface-2'],
	['--text', '--accent-soft'],
	['--text', '--warning-soft'],
	['--text-muted', '--bg'],
	['--text-muted', '--surface'],
	['--text-muted', '--surface-2'],
	['--accent', '--surface'],
	['--accent', '--surface-2'],
	['--accent', '--accent-soft'],
	['--on-accent', '--accent'],
	['--on-accent', '--accent-strong'],
	['--danger', '--surface'],
	['--danger', '--danger-soft'],
	['--warning', '--warning-soft'],
	['--success', '--success-soft'],
	['--bar-text', '--bar-bg'],
	['--bar-text', '--bar-bg-2'],
	['--bar-muted', '--bar-bg'],
	['--bar-muted', '--bar-bg-2'],
	['--bar-accent', '--bar-bg']
];

const SERIES = [...Array.from({ length: 12 }, (_, i) => `--series-${i + 1}`), '--series-neutral', '--series-observed'];

describe.each([
	['light', light],
	['dark', dark]
] as const)('the %s theme', (_name, theme) => {
	it.each(TEXT_PAIRS)('%s on %s reaches 4.5:1', (fg, bg) => {
		expect(contrast(theme[fg] as string, theme[bg] as string)).toBeGreaterThanOrEqual(4.5);
	});

	it.each(SERIES)('%s stands 3:1 off the chart surface', (token) => {
		expect(contrast(theme[token] as string, theme['--surface'] as string)).toBeGreaterThanOrEqual(3);
	});

	it('a control outline stands 3:1 off the surface', () => {
		expect(contrast(theme['--border-strong'] as string, theme['--surface'] as string)).toBeGreaterThanOrEqual(3);
	});
});

function svelteFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return svelteFiles(path);
		return entry.name.endsWith('.svelte') ? [path] : [];
	});
}

describe('components', () => {
	it.each(svelteFiles(SRC).map((path) => [path.slice(SRC.length + 1), path]))('%s writes no raw colour', (_name, path) => {
		const style = readFileSync(path, 'utf8').match(/<style>[\s\S]*<\/style>/)?.[0] ?? '';
		expect(style.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
	});
});
