<!--
	What the engine said about the runs: errors and warnings in view, notes
	folded away. Grouped (run-messages.ts), since a dry reservoir reports every
	month. A result that comes with a warning isn't to be read without it.
-->
<script lang="ts">
	import type { RunResult } from '@pitman/wrsm';
	import { groupRunMessages, groupSpan, messageSummary, type MessageGroup } from './run-messages.js';

	let { runs }: { runs: readonly RunResult[] } = $props();

	const groups = $derived(groupRunMessages(runs));
	const needed = $derived(groups.filter((g) => g.level !== 'info'));
	const notes = $derived(groups.filter((g) => g.level === 'info'));
	const summary = $derived(messageSummary(groups));
</script>

{#snippet line(group: MessageGroup)}
	<li data-level={group.level}>
		{#if group.level === 'error'}<strong>Error.</strong>{/if}
		{#if group.module}<strong>{group.module}.</strong>{/if}
		{group.text}
		{#if group.count > 1 || runs.length > 1}
			<span class="where">{[groupSpan(group), runs.length > 1 ? group.modes.join(', ') : ''].filter(Boolean).join('; ')}</span>
		{/if}
	</li>
{/snippet}

{#if groups.length > 0}
	<div class="run-messages" data-run-messages={needed.length}>
		<h3>{needed.length > 0 ? `Read before using these results: ${summary}` : 'Notes on this run'}</h3>
		{#if needed.length > 0}
			<ul>
				{#each needed as group, i (i)}{@render line(group)}{/each}
			</ul>
		{/if}
		{#if notes.length > 0}
			<details>
				<summary>{notes.length} {notes.length === 1 ? 'note' : 'notes'} from the run</summary>
				<ul>
					{#each notes as group, i (i)}{@render line(group)}{/each}
				</ul>
			</details>
		{/if}
	</div>
{/if}

<style>
	.run-messages {
		margin-block: 1rem;
		padding: 0.75rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	ul {
		margin: 0;
		padding-inline-start: 1.25rem;
	}
	li {
		margin-block: 0.35rem;
		overflow-wrap: anywhere;
	}
	.where {
		display: block;
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	details {
		margin-top: 0.5rem;
	}
</style>
