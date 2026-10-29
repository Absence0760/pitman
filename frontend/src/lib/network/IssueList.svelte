<!--
	Validation problems, grouped by file, each with its line and field.
	The heading takes focus when errors appear so keyboard and screen-reader
	users land on them.
-->
<script lang="ts">
	import type { BundleIssue } from './engine.js';
	import { groupIssues, issueLocation } from './issues.js';

	let { issues, title, id, focus = false }: { issues: readonly BundleIssue[]; title: string; id: string; focus?: boolean } = $props();

	let heading: HTMLHeadingElement | undefined = $state();
	const groups = $derived(groupIssues(issues));

	$effect(() => {
		if (focus && heading) heading.focus();
	});
</script>

<section class="issues" class:errors={issues.some((i) => i.level === 'error')} aria-labelledby={id}>
	<h2 {id} tabindex="-1" bind:this={heading}>{title}</h2>
	{#each groups as group (group.file)}
		<h3>{group.file}</h3>
		<ul>
			{#each group.issues as issue, k (k)}
				<li>
					<span class="where">{issueLocation(issue)}</span>
					<span class="what">{issue.message}</span>
				</li>
			{/each}
		</ul>
	{/each}
</section>

<style>
	.issues {
		border-left: 4px solid var(--warning);
		padding: 0.25rem 0 0.25rem 1rem;
		margin: 1.5rem 0;
	}
	.issues.errors {
		border-left-color: var(--danger);
	}
	h2 {
		font-size: 1.15rem;
		margin: 0 0 0.5rem;
	}
	h3 {
		font-size: 1rem;
		margin: 0.75rem 0 0.25rem;
		overflow-wrap: anywhere;
	}
	ul {
		margin: 0;
		padding-left: 1.25rem;
	}
	li {
		margin: 0.25rem 0;
	}
	.where {
		display: block;
		font-family: ui-monospace, monospace;
		font-size: 0.9rem;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
</style>
