/**
 * `use:scrollable` on a `.scroll` box: a table wider than its box must scroll
 * by keyboard too (WCAG 2.1.1). A box with something focusable in it scrolls as
 * the focus moves; one holding only numbers gets a tab stop and a name, and
 * only while it overflows, so a wide screen gains no empty stops.
 */

const STOPS = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, summary';

function nameOf(node: HTMLElement): string {
	const table = node.querySelector('table');
	return `${table?.getAttribute('aria-label') ?? table?.caption?.textContent?.trim() ?? 'Table'}, scrolls sideways`;
}

export function scrollable(node: HTMLElement) {
	const check = () => {
		if (node.scrollWidth > node.clientWidth + 1 && node.querySelector(STOPS) === null) {
			node.tabIndex = 0;
			node.setAttribute('role', 'group');
			node.setAttribute('aria-label', nameOf(node));
		} else {
			node.removeAttribute('tabindex');
			node.removeAttribute('role');
			node.removeAttribute('aria-label');
		}
	};
	const resized = new ResizeObserver(check);
	resized.observe(node);
	const changed = new MutationObserver(check);
	changed.observe(node, { childList: true, subtree: true });
	return {
		destroy() {
			resized.disconnect();
			changed.disconnect();
		}
	};
}
