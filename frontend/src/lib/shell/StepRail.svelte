<!--
	Where the loaded network stands, step by step. Links into the one page:
	every section stays mounted, so moving between steps never loses work
	(a half-done extension, a chosen route). Each state is said in words too.
-->
<script lang="ts">
	import type { Step } from './steps.js';

	let { steps }: { steps: readonly Step[] } = $props();

	const STATE_WORDS: Record<Step['state'], string> = { done: 'Done', active: 'In progress', failed: 'Failed', todo: 'To do' };
</script>

<nav class="rail" aria-label="Steps">
	<ol>
		{#each steps as step, i (step.id)}
			<li data-state={step.state}>
				<a href={`#${step.id}`}>
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
		display: flex;
		gap: 0.25rem;
		overflow-x: auto;
	}
	li {
		flex: 1 0 auto;
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
	/* A column beside the work on a wide screen, with a line joining the steps. */
	@media (min-width: 64rem) {
		.rail {
			position: sticky;
			top: calc(var(--bar-h) + 1.25rem);
		}
		ol {
			flex-direction: column;
			gap: 0.5rem;
			overflow: visible;
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
	@media (max-width: 64rem) {
		.detail {
			white-space: nowrap;
		}
	}
</style>
