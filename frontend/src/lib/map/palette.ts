// The map's colours. MapLibre paints on a canvas and can't read `var()`, so the
// tokens in app.css are read once per theme and handed to the style as plain
// values (Map.svelte redraws with setStyle when the theme flips). Pure apart
// from `readPalette`, so vitest checks the styles against both themes' tokens.

const SINGLE = {
	bg: '--map-bg',
	earth: '--map-earth',
	water: '--map-water',
	green: '--map-green',
	road: '--map-road',
	roadCase: '--map-road-case',
	border: '--map-border',
	casing: '--map-casing',
	label: '--map-label',
	labelWater: '--map-label-water',
	halo: '--map-halo',
	quaternary: '--map-quaternary',
	selected: '--map-selected',
	proposal: '--map-proposal',
	channel: '--map-channel',
	module: '--map-module'
} as const;

/** How many tints the pieces cycle through, and how many stops the MAP ramp has. */
export const PIECE_TINT_COUNT = 6;
export const RAMP_STOPS = 5;

export type Palette = Record<keyof typeof SINGLE, string> & {
	/** `--map-piece-1…6`: the pieces' fills. */
	readonly pieces: readonly string[];
	/** `--map-ramp-1…5`: the MAP ramp. */
	readonly ramp: readonly string[];
};

/** Every token the palette reads, for the guard. */
export const PALETTE_TOKENS: readonly string[] = [
	...Object.values(SINGLE),
	...Array.from({ length: PIECE_TINT_COUNT }, (_, i) => `--map-piece-${i + 1}`),
	...Array.from({ length: RAMP_STOPS }, (_, i) => `--map-ramp-${i + 1}`)
];

/** The palette, from something that gives a token's value. */
export function paletteFrom(read: (token: string) => string): Palette {
	const single = Object.fromEntries(Object.entries(SINGLE).map(([k, token]) => [k, read(token)])) as Record<keyof typeof SINGLE, string>;
	return {
		...single,
		pieces: Array.from({ length: PIECE_TINT_COUNT }, (_, i) => read(`--map-piece-${i + 1}`)),
		ramp: Array.from({ length: RAMP_STOPS }, (_, i) => read(`--map-ramp-${i + 1}`))
	};
}

/** The tokens as they hold on `node` now. */
export function readPalette(node: Element): Palette {
	const style = getComputedStyle(node);
	return paletteFrom((token) => style.getPropertyValue(token).trim());
}

/** `#rrggbb` at an opacity, as CSS `rgba()` (MapLibre reads it too). */
export function withAlpha(hex: string, alpha: number): string {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
