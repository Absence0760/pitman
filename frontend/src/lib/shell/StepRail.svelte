<!--
	Where the loaded network stands, step by step. Links into the one page:
	every section stays mounted, so moving between steps never loses work
	(a half-done extension, a chosen route). Each state is said in words too.
	The step you are in is marked as the page scrolls (`aria-current`): the
	section crossing a thin line under the bar, the last one at the end of the
	page, or the link just followed, since short sections can't reach that line.
-->
<script lang="ts">
	import type { Step } from './steps.js';

	let { steps, onnavigate }: { steps: readonly Step[]; onnavigate?: (id: string) => void } = $props();

	let seen = $state<string | undefined>();
	/** The link just followed, until the user scrolls on their own. */
	let followed = $state<string | undefined>();
	const current = $derived(followed ?? seen ?? steps[0]?.id);

	const pageEnd = () => scrollY + innerHeight >= document.documentElement.scrollHeight - 2;

	$effect(() => {
		const sections = new Map(steps.flatMap((step) => {
			const node = document.getElementById(step.id);
			const card = node?.closest('.card') ?? node;
			return card ? [[card, step.id] as const] : [];
		}));
		// A band 1 px high, low enough to fall in the first card at the top of the page and in a card a link has brought up.
		const top = Math.round((document.querySelector('header')?.getBoundingClientRect().height ?? 0) + 60);
		const line = new IntersectionObserver(
			(entries) => {
				// The observer and the scroll event arrive in either order, so the end of the page wins in both.
				for (const entry of entries) if (entry.isIntersecting) seen = pageEnd() ? steps.at(-1)?.id : sections.get(entry.target);
			},
			{ rootMargin: `-${top}px 0px -${Math.max(0, innerHeight - top - 1)}px 0px` }
		);
		for (const card of sections.keys()) line.observe(card);
		const release = () => (followed = undefined);
		const atEnd = () => {
			if (pageEnd()) seen = steps.at(-1)?.id;
		};
		addEventListener('scroll', atEnd, { passive: true });
		for (const event of ['wheel', 'touchmove', 'keydown'] as const) addEventListener(event, release, { passive: true });
		return () => {
			line.disconnect();
			removeEventListener('scroll', atEnd);
			for (const event of ['wheel', 'touchmove', 'keydown'] as const) removeEventListener(event, release);
		};
	});

	function follow(id: string) {
		followed = id;
		onnavigate?.(id);
	}

	const STATE_WORDS: Record<Step['state'], string> = { done: 'Done', active: 'In progress', failed: 'Failed', todo: 'To do' };
</script>

<nav class="rail" aria-label="Steps">
	<ol>
		{#each steps as step, i (step.id)}
			<li data-state={step.state}>
				<a href={`#${step.id}`} aria-current={step.id === current ? 'location' : undefined} onclick={() => follow(step.id)}>
					<span class="dot" aria-hidden="true">{step.state === 'done' ? '✓' : step.state === 'failed' ? '!' : i + 1}</span>
					<span class="text">
						<span class="label">{step.label}</span>
						<span class="detail"><span class="sr">{STATE_WORDS[step.state]}: </span>{step.detail}</span>
					</span>
				</a>
			</li>
		{/each}
	</ol>
</nav>

<style>
	ol {
		position: relative;
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: minmax(0, 1fr);
		gap: 0.25rem;
	}
	li {
		position: relative;
	}
	a {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.5rem 0.6rem;
		border-radius: var(--radius);
		color: var(--text);
		text-decoration: none;
	}
	a:hover {
		background: var(--accent-soft);
	}
	/* Where you are: an edge and a tint, not the colour alone. */
	a[aria-current='location'] {
		background: var(--accent-soft);
		box-shadow: inset 3px 0 0 var(--accent);
	}
	a[aria-current='location'] .label {
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	.dot {
		flex: none;
		display: grid;
		place-items: center;
		width: 1.625rem;
		height: 1.625rem;
		border-radius: 50%;
		border: 1px solid var(--border-strong);
		background: var(--surface);
		color: var(--text-muted);
		font-size: var(--font-xs);
		font-weight: 700;
	}
	li[data-state='done'] .dot {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}
	li[data-state='active'] .dot {
		border: 2px solid var(--accent);
		color: var(--accent);
	}
	li[data-state='failed'] .dot {
		background: var(--danger-soft);
		border-color: var(--danger);
		color: var(--danger);
	}
	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.label {
		font-weight: 600;
		font-size: 0.9rem;
		line-height: 1.625rem;
		white-space: nowrap;
	}
	.detail {
		color: var(--text-muted);
		font-size: var(--font-sm);
		line-height: 1.3;
	}
	@media (min-width: 40.01rem) and (max-width: 63.99rem) {
		ol {
			grid-auto-flow: row;
			grid-template-columns: repeat(5, minmax(0, 1fr));
		}
		.label {
			white-space: normal;
		}
	}
	/* A column beside the work on a wide screen, with a line joining the steps. */
	@media (min-width: 64rem) {
		.rail {
			position: sticky;
			top: calc(var(--bar-h) + 1.25rem);
			max-height: calc(100vh - var(--bar-h) - 2rem);
			overflow-y: auto;
		}
		ol {
			grid-auto-flow: row;
			gap: 0.5rem;
		}
		li:not(:last-child)::after {
			content: '';
			position: absolute;
			left: calc(0.6rem + 0.8125rem - 0.5px);
			top: 2.4rem;
			bottom: -0.6rem;
			width: 1px;
			background: var(--border-strong);
		}
	}
	/* All the steps fit a phone in two rows: the mark over a short name, and the detail for a screen reader
	   only (the bar's pill says how the run stands). */
	@media (max-width: 40rem) {
		ol {
			grid-auto-flow: row;
			grid-template-columns: repeat(5, minmax(0, 1fr));
		}
		a {
			flex-direction: column;
			align-items: center;
			gap: 0.15rem;
			padding: 0.4rem 0.15rem;
			text-align: center;
		}
		.label {
			font-size: var(--font-xs);
			line-height: 1.2;
			white-space: normal;
		}
		.detail {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
		}
	}
</style>
