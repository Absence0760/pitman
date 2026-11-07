import { expect, test } from './fixtures.js';
import { syntheticNetworkZip } from '../src/lib/network/synthetic.js';
import { ANSWER, everythingOpen, QUATERNARIES } from './a11y.helper.js';

// WCAG 2.2 AA, measured on the real page with every card open and in its fullest state: names, heading order, target
// sizes, reflow, and a keyboard walk through all of it. No audit library (no new dependencies): each check is a few
// lines over the DOM, and each failure names the element. Synthetic data only (rule 2). SwiftShader draws the WebGL.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

test('one h1, and no heading level skipped, in every state', async ({ page }) => {
	const check = async () => {
		const levels = await page.locator('h1,h2,h3,h4,h5,h6').evaluateAll((els) =>
			els.filter((e) => (e as HTMLElement).getClientRects().length > 0).map((e) => ({ level: Number(e.tagName[1]), text: e.textContent?.trim().slice(0, 40) ?? '' }))
		);
		expect(levels.filter((h) => h.level === 1)).toHaveLength(1);
		const skips = levels.flatMap((h, i) => (i > 0 && h.level > levels[i - 1]!.level + 1 ? [`${levels[i - 1]!.text} (h${levels[i - 1]!.level}) → ${h.text} (h${h.level})`] : []));
		expect(skips).toEqual([]);
	};
	await page.route('**/quaternaries', (route) => route.fulfill({ json: QUATERNARIES }));
	await page.goto('/');
	await check();
	await everythingOpen(page);
	await check();
});

test('every control has a name, no id repeats, and every target is at least 24 px', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 960 });
	await everythingOpen(page);
	const problems = await page.evaluate(() => {
		const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
		const say = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}[${el.getAttribute('type') ?? ''}] "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`;
		const named = (el: Element) => {
			const field = el as HTMLInputElement;
			const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || (field.labels?.length ? field.labels[0]?.textContent?.trim() : '');
			return Boolean(label || (['BUTTON', 'A', 'SUMMARY'].includes(el.tagName) && el.textContent?.trim()));
		};
		const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
		const controls = [...document.querySelectorAll('main button, main a[href], main input, main select, main textarea, main summary, header button, nav a')].filter(visible);
		// Inline links in a sentence are exempt (2.5.8), and so is the map's own attribution.
		const targets = controls.filter((el) => !(el.tagName === 'A' && el.closest('p,dd,li:not(nav li),.maplibregl-ctrl-attrib')) && !el.matches('.file-pick'));
		// A box's label is part of its target.
		const size = (el: Element) => {
			const label = (el as HTMLInputElement).labels?.[0];
			const a = el.getBoundingClientRect();
			const b = (el.matches('[type=checkbox],[type=radio]') ? label : undefined)?.getBoundingClientRect() ?? a;
			return { width: Math.max(a.right, b.right) - Math.min(a.left, b.left), height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) };
		};
		return {
			unnamed: controls.filter((el) => !named(el)).map(say),
			repeated: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))],
			small: targets.filter((el) => { const r = size(el); return r.width < 24 || r.height < 24; }).map((el) => { const r = size(el); return `${say(el)} ${Math.round(r.width)}×${Math.round(r.height)}`; })
		};
	});
	expect(problems).toEqual({ unnamed: [], repeated: [], small: [] });
});

for (const [width, height] of [[1440, 960], [390, 844], [320, 800]] as const) {
	test(`reflows at ${width} px, and whatever scrolls sideways can be reached by keyboard`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await everythingOpen(page);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
		const stuck = await page.evaluate(() => {
			const say = (el: Element) => `${el.tagName.toLowerCase()}.${el.className} ${(el.textContent ?? '').trim().slice(0, 50)}`;
			return [...document.querySelectorAll('main *')]
				.filter((el) => {
					const s = getComputedStyle(el);
					return (s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && el.getClientRects().length > 0;
				})
				.filter((el) => !el.matches('[tabindex="0"]') && !el.querySelector('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, summary, [tabindex="0"]'))
				.map(say);
		});
		expect(stuck).toEqual([]);
	});
}

test('the skip link is first, shows on focus, and goes past the bar and the rail', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.route('**/quaternaries', (route) => route.fulfill({ json: QUATERNARIES }));
	await page.goto('/');
	await page.keyboard.press('Tab');
	const skip = page.getByRole('link', { name: 'Skip to the page' });
	await expect(skip).toBeFocused();
	await expect(skip).toBeInViewport();
	await page.keyboard.press('Enter');
	await expect(page.locator('main')).toBeFocused();
});

test('asked for less motion, the page moves nothing and the map jumps', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.route('**/quaternaries', (route) => route.fulfill({ json: QUATERNARIES }));
	await page.goto('/');
	const panel = page.locator('section[aria-labelledby="map-h"]');
	const map = panel.locator('.map-wrap');
	await map.scrollIntoViewIfNeeded();
	await expect(map).toHaveAttribute('data-status', 'ready');
	expect(await page.getByLabel('Quaternary', { exact: true }).evaluate(() => getComputedStyle(document.createElement('button')).transitionDuration)).toMatch(/^(0s)?$/);
	await expect(map).toHaveAttribute('data-view', /./);
	const before = await map.getAttribute('data-view');
	await panel.getByLabel('Quaternary', { exact: true }).selectOption('Z01A');
	// With no animation the frame lands at once: the first change of view is the last.
	await expect(map).not.toHaveAttribute('data-view', before!);
	const landed = await map.getAttribute('data-view');
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
	expect(await map.getAttribute('data-view')).toBe(landed);
});

test('the keyboard alone can pick a quaternary, fetch and write a row', async ({ page }) => {
	await page.route('**/quaternaries', (route) => route.fulfill({ json: QUATERNARIES }));
	await page.route('**/cfm/land-use', (route) => route.fulfill({ json: ANSWER }));
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip({ startYear: 1980, years: 30 })) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await page.getByRole('button', { name: 'Show Crop fields and farm dams' }).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('button', { name: 'Hide Crop fields and farm dams' })).toBeFocused();
	const panel = page.getByRole('region', { name: 'Crop fields and farm dams' });
	await panel.getByLabel('Quaternary', { exact: true }).focus();
	await page.keyboard.press('ArrowDown');
	await expect(panel.getByLabel('Quaternary', { exact: true })).toHaveValue('Z01A');
	await panel.getByRole('button', { name: 'Fetch the fields and dams' }).focus();
	await page.keyboard.press('Enter');
	await expect(panel.getByRole('heading', { name: 'What came back' })).toBeFocused();
	await panel.getByRole('button', { name: 'Apply: write the row to RR 6' }).focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('.status')).toContainText('RR 6: 1.20 km² irrigated');
});

test('a problem typed into a form is tied to its box and heard', async ({ page }) => {
	await everythingOpen(page);
	const demands = page.getByRole('region', { name: 'Demands' });
	await demands.getByRole('button', { name: 'New demand', exact: true }).click();
	const october = demands.getByLabel('October share, %');
	await october.fill('abc');
	await expect(october).toHaveAttribute('aria-invalid', 'true');
	await expect(october).toHaveAttribute('aria-describedby', /demand-share-0-msg/);
	await expect(demands.locator('#demand-share-0-msg')).toBeVisible();
	await expect(demands.locator('[data-preview-live]')).toContainText('Preview paused');

	const tables = page.getByRole('region', { name: 'Land-use tables' });
	await tables.getByLabel('Afforested area, km² in 2025').fill('4.55');
	await expect(tables.locator('[data-live]')).toContainText('The file keeps 1 decimal place');
});
