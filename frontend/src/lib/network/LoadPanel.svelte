<!--
	Load a network: a zip, a folder (<input webkitdirectory>), or either
	dropped on the drop area. Hands the files to the page as SourceFiles; the
	bytes are read in the browser, nothing is uploaded.
-->
<script lang="ts">
	import { fromDropEntries, fromFileList, type DropEntry, type SourceFile } from './sources.js';

	let { onload, busy = false }: { onload: (sources: SourceFile[]) => void; busy?: boolean } = $props();

	let dragging = $state(false);

	function picked(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		if (input.files && input.files.length > 0) onload(fromFileList(input.files));
		// Picking the same file again must fire change again.
		input.value = '';
	}

	async function dropped(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		const transfer = event.dataTransfer;
		if (!transfer) return;
		const entries = [...transfer.items]
			.map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
			.filter((entry): entry is FileSystemEntry => entry !== null);
		if (entries.length > 0) onload(await fromDropEntries(entries as unknown as DropEntry[]));
		else if (transfer.files.length > 0) onload(fromFileList(transfer.files));
	}
</script>

<div class="pickers">
	<div class="picker">
		<label for="load-zip">Network zip</label>
		<input id="load-zip" type="file" accept=".zip,application/zip" disabled={busy} onchange={picked} />
	</div>
	<div class="picker">
		<label for="load-folder">Network folder</label>
		<input id="load-folder" type="file" webkitdirectory multiple disabled={busy} onchange={picked} />
	</div>
</div>

<div
	class="drop"
	class:dragging
	role="region"
	aria-label="Drop area for a network zip or folder"
	ondragenter={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragover={(e) => e.preventDefault()}
	ondragleave={() => (dragging = false)}
	ondrop={dropped}
>
	<p>Or drop the network's zip or folder here.</p>
</div>

<style>
	.pickers {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem 2rem;
	}
	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
	}
	label {
		font-weight: 600;
	}
	input[type='file'] {
		max-width: 100%;
		min-height: 2.75rem;
	}
	.drop {
		margin-top: 1rem;
		border: 2px dashed var(--border-strong);
		border-radius: 0.5rem;
		padding: 1.25rem 1rem;
		text-align: center;
		color: var(--text-muted);
	}
	.drop.dragging {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text);
	}
	.drop p {
		margin: 0;
	}
</style>
