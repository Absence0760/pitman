import { expect, test, type Page } from './fixtures.js';
import { everythingOpen } from './a11y.helper.js';

// A keyboard walk through the whole page, in two halves, so the second isn't paying for the first, and with no WebGL:
// repainting three software-drawn maps at every stop is what a walk mustn't wait on, and a page whose maps can't
// draw is a state of its own to pass. The map's own keys are in map.spec.ts.
test.use({ viewport: { width: 1440, height: 960 }, launchOptions: { args: ['--disable-3d-apis'] } });

/** Tab from `from` until a stop named `until`, checking every stop on the way. */
async function walk(page: Page, from: ReturnType<Page['getByRole']>, until: string) {
	await from.focus();
	const stops: string[] = [];
	const problems: string[] = [];
	for (let i = 0; i < 400; i++) {
		await page.keyboard.press('Tab');
		const stop = await page.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			if (!el || el === document.body) return null;
			const scope = window as unknown as { lastStop?: Element };
			const same = scope.lastStop === el;
			scope.lastStop = el;
			const shown = (el.matches('.file-pick') ? (el.nextElementSibling as HTMLElement) : el);
			const style = getComputedStyle(shown);
			const r = shown.getBoundingClientRect();
			const bar = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
			const inBar = el.closest('header') !== null;
			return {
				name: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`,
				same,
				outlined: parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none',
				clear: inBar || r.bottom > bar + 1,
				onScreen: r.width > 0 && r.bottom > 0 && r.top < innerHeight
			};
		});
		if (stop === null) break;
		if (stop.same) problems.push(`stuck on ${stop.name}`);
		stops.push(stop.name);
		if (!stop.outlined) problems.push(`no focus outline: ${stop.name}`);
		if (!stop.clear) problems.push(`hidden under the bar: ${stop.name}`);
		if (!stop.onScreen) problems.push(`off screen: ${stop.name}`);
		if (stop.name.includes(until)) break;
	}
	expect(problems).toEqual([]);
	expect(stops.at(-1)).toContain(until);
	return stops;
}

test('from the top to Calibrate: every stop visible, outlined and clear of the bar, and no trap', async ({ page }) => {
	await everythingOpen(page);
	const stops = await walk(page, page.getByRole('link', { name: 'Skip to the page' }), 'Hide Calibrate');
	expect(stops.some((s) => s.includes('Save as WRSM2000 zip'))).toBe(true);
	expect(stops.some((s) => s.includes('Hide Demands'))).toBe(true);
});

test('from Calibrate to the end of the page, in the same way', async ({ page }) => {
	await everythingOpen(page);
	const stops = await walk(page, page.getByRole('button', { name: 'Hide Calibrate' }), 'Methods');
	expect(stops.some((s) => s.includes('Download CSV'))).toBe(true);
});
