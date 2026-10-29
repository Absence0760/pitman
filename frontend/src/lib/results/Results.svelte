<!--
	Results for a loaded network: one entry in `runs` per mode the user ran.
	Stub from the Round 3 contract (orchestrator); agent 3.5 owns this file
	and replaces the body. The props are the contract with the app shell
	(3.4): keep their names and types.
-->
<script lang="ts">
	import type { NetworkBundle, RunResult } from '@pitman/wrsm';

	let { bundle, runs }: { bundle: NetworkBundle; runs: readonly RunResult[] } = $props();
</script>

<section aria-label="Results">
	<p>{runs.length} run(s) of network {bundle.network.code}.</p>
</section>
